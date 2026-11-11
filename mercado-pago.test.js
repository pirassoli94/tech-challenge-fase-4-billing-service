process.env.NODE_ENV = "test";

require("dotenv").config({
  path: ".env.test",
  override: true,
  quiet: true
});

// Garante que o token exista durante os testes
process.env.MERCADO_PAGO_ACCESS_TOKEN =
  process.env.MERCADO_PAGO_ACCESS_TOKEN ||
  "APP_USR-TOKEN-DE-TESTE-SIMULADO";

// Mock do SDK do Mercado Pago
const mockCriarPreferencia = jest.fn();

jest.mock("mercadopago", () => ({
  MercadoPagoConfig: jest.fn().mockImplementation(
    (configuracao) => configuracao
  ),

  Preference: jest.fn().mockImplementation(() => ({
    create: mockCriarPreferencia
  }))
}));

const request = require("supertest");

const {
  app,
  pool,
  definirCanalRabbitMQ
} = require("./index");

const canalRabbitMQMock = {
  sendToQueue: jest.fn(),
  ack: jest.fn()
};

let orcamentoId;
let pagamentoPendenteId;
let pagamentoConfirmadoId;
let pagamentoRecusadoId;

async function criarPagamento(valor = 500) {
  const resultado = await pool.query(
    `INSERT INTO pagamentos
     (orcamento_id, valor)
     VALUES ($1, $2)
     RETURNING *`,
    [
      orcamentoId,
      valor
    ]
  );

  return resultado.rows[0];
}

function respostaFetch({
  ok = true,
  status = 200,
  json = {},
  texto = ""
} = {}) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(json),
    text: jest.fn().mockResolvedValue(texto)
  };
}

beforeAll(async () => {
  await pool.query(
    `TRUNCATE TABLE pagamentos, orcamentos
     RESTART IDENTITY CASCADE`
  );

  const orcamento = await pool.query(
    `INSERT INTO orcamentos
     (ordem_id, valor, descricao, status)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      100,
      500,
      "Teste Mercado Pago",
      "APROVADO"
    ]
  );

  orcamentoId = orcamento.rows[0].id;

  definirCanalRabbitMQ(canalRabbitMQMock);
});

beforeEach(() => {
  jest.clearAllMocks();

  mockCriarPreferencia.mockResolvedValue({
    id: "PREF-TESTE-001",
    sandbox_init_point:
      "https://sandbox.mercadopago.com.br/teste"
  });

  global.fetch = jest.fn();
});

describe("Checkout Pro", () => {
  test("deve criar preferÃªncia para pagamento pendente", async () => {
    const pagamento = await criarPagamento(500);
    pagamentoPendenteId = pagamento.id;

    const resposta = await request(app)
      .post(
        `/pagamentos/${pagamentoPendenteId}/checkout`
      );

    expect(resposta.status).toBe(201);

    expect(resposta.body.preference_id)
      .toBe("PREF-TESTE-001");

    expect(resposta.body.checkout_url)
      .toBe(
        "https://sandbox.mercadopago.com.br/teste"
      );

    expect(mockCriarPreferencia)
      .toHaveBeenCalledTimes(1);

    const chamada =
      mockCriarPreferencia.mock.calls[0][0];

    expect(
      chamada.body.external_reference
    ).toBe(String(pagamentoPendenteId));

    expect(
      chamada.body.items[0].unit_price
    ).toBe(500);
  });

  test("deve rejeitar ID invÃ¡lido no checkout", async () => {
    const resposta = await request(app)
      .post("/pagamentos/abc/checkout");

    expect(resposta.status).toBe(400);
    expect(resposta.body.mensagem)
      .toBe("ID de pagamento inválido");
  });

  test("deve retornar 404 para pagamento inexistente", async () => {
    const resposta = await request(app)
      .post("/pagamentos/999999/checkout");

    expect(resposta.status).toBe(404);
    expect(resposta.body.mensagem)
      .toBe("Pagamento não encontrado");
  });

  test("deve impedir checkout de pagamento confirmado", async () => {
    const pagamento = await criarPagamento(600);

    await pool.query(
      `UPDATE pagamentos
       SET status = 'CONFIRMADO'
       WHERE id = $1`,
      [pagamento.id]
    );

    const resposta = await request(app)
      .post(`/pagamentos/${pagamento.id}/checkout`);

    expect(resposta.status).toBe(400);
    expect(resposta.body.statusAtual)
      .toBe("CONFIRMADO");
  });

  test("deve exigir Access Token", async () => {
    const pagamento = await criarPagamento(700);

    const tokenOriginal =
      process.env.MERCADO_PAGO_ACCESS_TOKEN;

    delete process.env.MERCADO_PAGO_ACCESS_TOKEN;

    const resposta = await request(app)
      .post(`/pagamentos/${pagamento.id}/checkout`);

    process.env.MERCADO_PAGO_ACCESS_TOKEN =
      tokenOriginal;

    expect(resposta.status).toBe(500);
    expect(resposta.body.mensagem)
      .toBe(
        "Access Token do Mercado Pago não configurado"
      );
  });

  test("deve tratar falha ao criar preferÃªncia", async () => {
    const pagamento = await criarPagamento(800);

    mockCriarPreferencia.mockRejectedValueOnce(
      new Error("Falha simulada no Mercado Pago")
    );

    const resposta = await request(app)
      .post(`/pagamentos/${pagamento.id}/checkout`);

    expect(resposta.status).toBe(502);
    expect(resposta.body.mensagem)
      .toBe(
        "Erro ao criar preferência no Mercado Pago"
      );
  });
});

describe("SincronizaÃ§Ã£o com Mercado Pago", () => {
  test("deve rejeitar ID invÃ¡lido", async () => {
    const resposta = await request(app)
      .post("/pagamentos/abc/sincronizar");

    expect(resposta.status).toBe(400);
  });

  test("deve retornar 404 quando a busca nÃ£o encontrar pagamento", async () => {
    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          results: []
        }
      })
    );

    const resposta = await request(app)
      .post(
        `/pagamentos/${pagamentoPendenteId}/sincronizar`
      );

    expect(resposta.status).toBe(404);
  });

  test("deve confirmar pagamento aprovado e publicar evento", async () => {
    const pagamento = await criarPagamento(900);
    pagamentoConfirmadoId = pagamento.id;

    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          results: [
            {
              id: 123456789,
              external_reference:
                String(pagamentoConfirmadoId),
              status: "approved",
              status_detail: "accredited"
            }
          ]
        }
      })
    );

    const resposta = await request(app)
      .post(
        `/pagamentos/${pagamentoConfirmadoId}/sincronizar`
      );

    expect(resposta.status).toBe(200);

    expect(resposta.body.pagamento.status)
      .toBe("CONFIRMADO");

    expect(
      resposta.body.pagamento.referencia_externa
    ).toBe("123456789");

    expect(canalRabbitMQMock.sendToQueue)
      .toHaveBeenCalledWith(
        "pagamento_confirmado",
        expect.any(Buffer),
        {
          persistent: true
        }
      );
  });

  test("nÃ£o deve publicar evento duplicado para pagamento jÃ¡ confirmado", async () => {
    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          results: [
            {
              id: 123456789,
              external_reference:
                String(pagamentoConfirmadoId),
              status: "approved",
              status_detail: "accredited"
            }
          ]
        }
      })
    );

    const resposta = await request(app)
      .post(
        `/pagamentos/${pagamentoConfirmadoId}/sincronizar`
      );

    expect(resposta.status).toBe(200);

    expect(canalRabbitMQMock.sendToQueue)
      .not.toHaveBeenCalled();
  });

  test("deve marcar pagamento rejeitado como RECUSADO", async () => {
    const pagamento = await criarPagamento(1000);
    pagamentoRecusadoId = pagamento.id;

    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          results: [
            {
              id: 987654321,
              external_reference:
                String(pagamentoRecusadoId),
              status: "rejected",
              status_detail:
                "cc_rejected_other_reason"
            }
          ]
        }
      })
    );

    const resposta = await request(app)
      .post(
        `/pagamentos/${pagamentoRecusadoId}/sincronizar`
      );

    expect(resposta.status).toBe(200);
    expect(resposta.body.pagamento.status)
      .toBe("RECUSADO");
  });

  test("deve manter pagamento pendente", async () => {
    const pagamento = await criarPagamento(1100);

    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          results: [
            {
              id: 1122334455,
              external_reference:
                String(pagamento.id),
              status: "pending",
              status_detail: "pending_waiting_payment"
            }
          ]
        }
      })
    );

    const resposta = await request(app)
      .post(`/pagamentos/${pagamento.id}/sincronizar`);

    expect(resposta.status).toBe(200);
    expect(resposta.body.pagamento.status)
      .toBe("PENDENTE");
  });

  test("deve tratar erro HTTP na busca", async () => {
    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        ok: false,
        status: 500,
        texto: "Erro externo simulado"
      })
    );

    const resposta = await request(app)
      .post(
        `/pagamentos/${pagamentoPendenteId}/sincronizar`
      );

    expect(resposta.status).toBe(502);
    expect(resposta.body.mensagem)
      .toBe(
        "Erro ao sincronizar com o Mercado Pago"
      );
  });
});

describe("Webhook Mercado Pago", () => {
  test("deve reconhecer webhook sem ID", async () => {
    const resposta = await request(app)
      .post("/webhooks/mercado-pago")
      .send({});

    expect(resposta.status).toBe(200);
    expect(resposta.body.recebido)
      .toBe(true);
    expect(resposta.body.processado)
      .toBe(false);
  });

  test("deve consultar e processar pagamento aprovado", async () => {
    const pagamento = await criarPagamento(1200);

    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          id: 5566778899,
          external_reference:
            String(pagamento.id),
          status: "approved",
          status_detail: "accredited"
        }
      })
    );

    const resposta = await request(app)
      .post("/webhooks/mercado-pago")
      .send({
        data: {
          id: "5566778899"
        }
      });

    expect(resposta.status).toBe(200);
    expect(resposta.body.processado)
      .toBe(true);
    expect(resposta.body.pagamento.status)
      .toBe("CONFIRMADO");

    expect(global.fetch)
      .toHaveBeenCalledWith(
        "https://api.mercadopago.com/v1/payments/5566778899",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization:
              expect.stringContaining("Bearer ")
          })
        })
      );
  });

  test("deve aceitar ID pela query string", async () => {
    const pagamento = await criarPagamento(1300);

    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          id: 9988776655,
          external_reference:
            String(pagamento.id),
          status: "approved",
          status_detail: "accredited"
        }
      })
    );

    const resposta = await request(app)
      .post(
        "/webhooks/mercado-pago?data.id=9988776655"
      )
      .send({});

    expect(resposta.status).toBe(200);
    expect(resposta.body.processado)
      .toBe(true);
  });

  test("deve retornar 500 quando a consulta externa falhar", async () => {
    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        ok: false,
        status: 404,
        texto: "Pagamento externo nÃ£o encontrado"
      })
    );

    const resposta = await request(app)
      .post("/webhooks/mercado-pago")
      .send({
        data: {
          id: "000000"
        }
      });

    expect(resposta.status).toBe(500);
    expect(resposta.body.recebido)
      .toBe(true);
    expect(resposta.body.processado)
      .toBe(false);
  });

  test("deve retornar erro para referÃªncia interna inexistente", async () => {
    global.fetch.mockResolvedValueOnce(
      respostaFetch({
        json: {
          id: 4433221100,
          external_reference: "999999",
          status: "approved",
          status_detail: "accredited"
        }
      })
    );

    const resposta = await request(app)
      .post("/webhooks/mercado-pago")
      .send({
        data: {
          id: "4433221100"
        }
      });

    expect(resposta.status).toBe(500);
    expect(resposta.body.processado)
      .toBe(false);
  });
});

afterAll(async () => {
  await pool.query(
    `TRUNCATE TABLE pagamentos, orcamentos
     RESTART IDENTITY CASCADE`
  );

  await pool.end();
});

