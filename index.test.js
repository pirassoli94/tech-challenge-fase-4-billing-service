// Define o ambiente de teste antes de importar o Billing Service
process.env.NODE_ENV = "test";

// Carrega as configurações exclusivas dos testes
require("dotenv").config({
  path: ".env.test",
  override: true,
  quiet: true
});

// Importa o Supertest
const request = require("supertest");

// Importa a aplicação, o PostgreSQL
// e a função do canal RabbitMQ simulado
const {
  app,
  pool,
  definirCanalRabbitMQ
} = require("./index");

// IDs criados durante os testes
let orcamentoId;
let pagamentoId;

// Canal RabbitMQ simulado
const canalRabbitMQMock = {
  sendToQueue: jest.fn(),
  ack: jest.fn()
};


// ======================================================
// PREPARAÇÃO DOS TESTES
// ======================================================

beforeAll(async () => {

  // Limpa o banco de teste antes de começar
  await pool.query(
    `TRUNCATE TABLE pagamentos, orcamentos
     RESTART IDENTITY CASCADE`
  );

  // Fornece o canal RabbitMQ simulado ao Billing Service
  definirCanalRabbitMQ(canalRabbitMQMock);
});


beforeEach(() => {

  // Limpa chamadas anteriores dos mocks
  jest.clearAllMocks();

  // Simula uma resposta positiva da API do OS Service
  global.fetch = jest.fn().mockResolvedValue({
    status: 200,
    ok: true
  });
});


describe("Billing Service", () => {

  // ======================================================
  // ROTA PRINCIPAL
  // ======================================================

  test("GET / deve informar que o serviço está funcionando", async () => {

    const resposta = await request(app)
      .get("/");

    expect(resposta.status).toBe(200);

    expect(resposta.body).toEqual({
      mensagem: "Billing Service está funcionando!"
    });
  });


  // ======================================================
  // ORÇAMENTOS
  // ======================================================

  test("POST /orcamentos deve criar um orçamento", async () => {

    const resposta = await request(app)
      .post("/orcamentos")
      .send({
        ordem_id: 10,
        valor: 1500.00,
        descricao: "Orçamento automatizado"
      });

    expect(resposta.status).toBe(201);

    expect(resposta.body.ordem_id)
      .toBe(10);

    expect(resposta.body.valor)
      .toBe("1500.00");

    expect(resposta.body.status)
      .toBe("PENDENTE");

    orcamentoId = resposta.body.id;

    expect(global.fetch)
      .toHaveBeenCalledWith(
        "http://localhost:3000/ordens/10"
      );
  });


  test("POST /orcamentos deve exigir os campos obrigatórios", async () => {

    const resposta = await request(app)
      .post("/orcamentos")
      .send({
        ordem_id: 10
      });

    expect(resposta.status).toBe(400);

    expect(resposta.body.mensagem)
      .toBe(
        "Ordem, valor e descrição são obrigatórios"
      );
  });


  test("POST /orcamentos deve bloquear uma ordem inexistente", async () => {

    global.fetch.mockResolvedValueOnce({
      status: 404,
      ok: false
    });

    const resposta = await request(app)
      .post("/orcamentos")
      .send({
        ordem_id: 999,
        valor: 500.00,
        descricao: "Ordem inexistente"
      });

    expect(resposta.status).toBe(400);

    expect(resposta.body.mensagem)
      .toBe(
        "Não é possível criar o orçamento: ordem não encontrada"
      );
  });


  test("POST /orcamentos deve retornar 502 quando o OS Service falhar", async () => {

    global.fetch.mockResolvedValueOnce({
      status: 500,
      ok: false
    });

    const resposta = await request(app)
      .post("/orcamentos")
      .send({
        ordem_id: 50,
        valor: 500.00,
        descricao: "Teste de erro do OS Service"
      });

    expect(resposta.status).toBe(502);

    expect(resposta.body.mensagem)
      .toBe("Erro ao consultar o OS Service");
  });


  test("GET /orcamentos deve listar os orçamentos", async () => {

    const resposta = await request(app)
      .get("/orcamentos");

    expect(resposta.status).toBe(200);

    expect(Array.isArray(resposta.body))
      .toBe(true);

    expect(resposta.body.length)
      .toBeGreaterThan(0);
  });


  test("GET /orcamentos/:id deve buscar um orçamento", async () => {

    const resposta = await request(app)
      .get(`/orcamentos/${orcamentoId}`);

    expect(resposta.status).toBe(200);

    expect(resposta.body.id)
      .toBe(orcamentoId);

    expect(resposta.body.ordem_id)
      .toBe(10);
  });


  test("GET /orcamentos/:id deve retornar 404 para orçamento inexistente", async () => {

    const resposta = await request(app)
      .get("/orcamentos/999999");

    expect(resposta.status).toBe(404);

    expect(resposta.body.mensagem)
      .toBe("Orçamento não encontrado");
  });


  test("PATCH /orcamentos/:id/status deve aprovar o orçamento", async () => {

    const resposta = await request(app)
      .patch(`/orcamentos/${orcamentoId}/status`)
      .send({
        status: "APROVADO"
      });

    expect(resposta.status).toBe(200);

    expect(resposta.body.status)
      .toBe("APROVADO");
  });


  test("PATCH /orcamentos/:id/status deve rejeitar status inválido", async () => {

    const resposta = await request(app)
      .patch(`/orcamentos/${orcamentoId}/status`)
      .send({
        status: "STATUS_INVENTADO"
      });

    expect(resposta.status).toBe(400);

    expect(resposta.body.mensagem)
      .toBe("Status inválido");
  });


  test("PATCH /orcamentos/:id/status deve exigir o status", async () => {

    const resposta = await request(app)
      .patch(`/orcamentos/${orcamentoId}/status`)
      .send({});

    expect(resposta.status).toBe(400);

    expect(resposta.body.mensagem)
      .toBe("O novo status é obrigatório");
  });


  // ======================================================
  // PAGAMENTOS
  // ======================================================

  test("POST /pagamentos deve criar um pagamento", async () => {

    const resposta = await request(app)
      .post("/pagamentos")
      .send({
        orcamento_id: orcamentoId,
        valor: 1500.00
      });

    expect(resposta.status).toBe(201);

    expect(resposta.body.orcamento_id)
      .toBe(orcamentoId);

    expect(resposta.body.valor)
      .toBe("1500.00");

    expect(resposta.body.status)
      .toBe("PENDENTE");

    pagamentoId = resposta.body.id;
  });


  test("POST /pagamentos deve exigir os campos obrigatórios", async () => {

    const resposta = await request(app)
      .post("/pagamentos")
      .send({
        orcamento_id: orcamentoId
      });

    expect(resposta.status).toBe(400);

    expect(resposta.body.mensagem)
      .toBe(
        "Orçamento e valor são obrigatórios"
      );
  });


  test("GET /pagamentos deve listar os pagamentos", async () => {

    const resposta = await request(app)
      .get("/pagamentos");

    expect(resposta.status).toBe(200);

    expect(Array.isArray(resposta.body))
      .toBe(true);

    expect(resposta.body.length)
      .toBeGreaterThan(0);
  });


  test("GET /pagamentos/:id deve buscar um pagamento", async () => {

    const resposta = await request(app)
      .get(`/pagamentos/${pagamentoId}`);

    expect(resposta.status).toBe(200);

    expect(resposta.body.id)
      .toBe(pagamentoId);
  });


  test("GET /pagamentos/:id deve retornar 404 para pagamento inexistente", async () => {

    const resposta = await request(app)
      .get("/pagamentos/999999");

    expect(resposta.status).toBe(404);

    expect(resposta.body.mensagem)
      .toBe("Pagamento não encontrado");
  });


  test("GET pagamento confirmado deve retornar 404 antes da confirmação", async () => {

    const resposta = await request(app)
      .get("/pagamentos/ordem/10/confirmado");

    expect(resposta.status).toBe(404);

    expect(resposta.body.confirmado)
      .toBe(false);
  });


  test("PATCH /pagamentos/:id/status deve confirmar o pagamento", async () => {

    const resposta = await request(app)
      .patch(`/pagamentos/${pagamentoId}/status`)
      .send({
        status: "CONFIRMADO",
        referencia_externa: "TESTE-AUTOMATIZADO-001"
      });

    expect(resposta.status).toBe(200);

    expect(resposta.body.status)
      .toBe("CONFIRMADO");

    expect(resposta.body.referencia_externa)
      .toBe("TESTE-AUTOMATIZADO-001");

    // Verifica se o evento foi enviado ao RabbitMQ simulado
    expect(canalRabbitMQMock.sendToQueue)
      .toHaveBeenCalledWith(
        "pagamento_confirmado",
        expect.any(Buffer),
        {
          persistent: true
        }
      );
  });


  test("PATCH pagamento CONFIRMADO deve publicar os dados corretos", async () => {

    // Cria outro pagamento exclusivo para este teste
    const novoPagamento = await pool.query(
      `INSERT INTO pagamentos
       (orcamento_id, valor)
       VALUES ($1, $2)
       RETURNING *`,
      [
        orcamentoId,
        1800.00
      ]
    );

    const novoPagamentoId =
      novoPagamento.rows[0].id;

    const resposta = await request(app)
      .patch(`/pagamentos/${novoPagamentoId}/status`)
      .send({
        status: "CONFIRMADO",
        referencia_externa: "RABBIT-TESTE-001"
      });

    expect(resposta.status).toBe(200);

    expect(canalRabbitMQMock.sendToQueue)
      .toHaveBeenCalledWith(
        "pagamento_confirmado",
        expect.any(Buffer),
        {
          persistent: true
        }
      );

    // Pega a mensagem enviada ao canal simulado
    const bufferEnviado =
      canalRabbitMQMock.sendToQueue.mock.calls[0][1];

    const mensagem = JSON.parse(
      bufferEnviado.toString()
    );

    expect(mensagem.tipo)
      .toBe("PAGAMENTO_CONFIRMADO");

    expect(mensagem.pagamento_id)
      .toBe(novoPagamentoId);

    expect(mensagem.orcamento_id)
      .toBe(orcamentoId);

    expect(mensagem.valor)
      .toBe("1800.00");
  });


  test("GET pagamento confirmado deve encontrar o pagamento", async () => {

    const resposta = await request(app)
      .get("/pagamentos/ordem/10/confirmado");

    expect(resposta.status).toBe(200);

    expect(resposta.body.confirmado)
      .toBe(true);

    expect(resposta.body.pagamento)
      .toBeDefined();
  });


  test("PATCH /pagamentos/:id/status deve rejeitar status inválido", async () => {

    const resposta = await request(app)
      .patch(`/pagamentos/${pagamentoId}/status`)
      .send({
        status: "STATUS_INVENTADO"
      });

    expect(resposta.status).toBe(400);

    expect(resposta.body.mensagem)
      .toBe("Status inválido");
  });


  test("PATCH /pagamentos/:id/status deve exigir o status", async () => {

    const resposta = await request(app)
      .patch(`/pagamentos/${pagamentoId}/status`)
      .send({});

    expect(resposta.status).toBe(400);

    expect(resposta.body.mensagem)
      .toBe("O novo status é obrigatório");
  });


  test("PATCH /pagamentos/:id/status deve retornar 404 para pagamento inexistente", async () => {

    const resposta = await request(app)
      .patch("/pagamentos/999999/status")
      .send({
        status: "RECUSADO"
      });

    expect(resposta.status).toBe(404);

    expect(resposta.body.mensagem)
      .toBe("Pagamento não encontrado");
  });


  test("PATCH /pagamentos/:id/status deve aceitar CANCELAMENTO_PENDENTE", async () => {

    const resposta = await request(app)
      .patch(`/pagamentos/${pagamentoId}/status`)
      .send({
        status: "CANCELAMENTO_PENDENTE"
      });

    expect(resposta.status).toBe(200);

    expect(resposta.body.status)
      .toBe("CANCELAMENTO_PENDENTE");
  });


  // ======================================================
  // ERROS SIMULADOS DO POSTGRESQL
  // ======================================================

  test("GET /orcamentos deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao listar orçamentos")
      );

    const resposta = await request(app)
      .get("/orcamentos");

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao listar orçamentos");
  });


  test("GET /orcamentos/:id deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao buscar orçamento")
      );

    const resposta = await request(app)
      .get(`/orcamentos/${orcamentoId}`);

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao buscar orçamento");
  });


  test("POST /orcamentos deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao criar orçamento")
      );

    const resposta = await request(app)
      .post("/orcamentos")
      .send({
        ordem_id: 60,
        valor: 600.00,
        descricao: "Teste de erro do PostgreSQL"
      });

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao criar orçamento");
  });


  test("PATCH orçamento deve retornar 404 para orçamento inexistente", async () => {

    const resposta = await request(app)
      .patch("/orcamentos/999999/status")
      .send({
        status: "APROVADO"
      });

    expect(resposta.status).toBe(404);

    expect(resposta.body.mensagem)
      .toBe("Orçamento não encontrado");
  });


  test("PATCH orçamento deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao atualizar orçamento")
      );

    const resposta = await request(app)
      .patch(`/orcamentos/${orcamentoId}/status`)
      .send({
        status: "APROVADO"
      });

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao atualizar orçamento");
  });


  test("GET /pagamentos deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao listar pagamentos")
      );

    const resposta = await request(app)
      .get("/pagamentos");

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao listar pagamentos");
  });


  test("GET /pagamentos/:id deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao buscar pagamento")
      );

    const resposta = await request(app)
      .get(`/pagamentos/${pagamentoId}`);

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao buscar pagamento");
  });


  test("GET pagamento confirmado deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao verificar pagamento")
      );

    const resposta = await request(app)
      .get("/pagamentos/ordem/10/confirmado");

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao verificar pagamento");
  });


  test("POST /pagamentos deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao criar pagamento")
      );

    const resposta = await request(app)
      .post("/pagamentos")
      .send({
        orcamento_id: orcamentoId,
        valor: 1500.00
      });

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao registrar pagamento");
  });


  test("PATCH pagamento deve retornar 500 quando o PostgreSQL falhar", async () => {

    jest.spyOn(pool, "query")
      .mockRejectedValueOnce(
        new Error("Falha simulada ao atualizar pagamento")
      );

    const resposta = await request(app)
      .patch(`/pagamentos/${pagamentoId}/status`)
      .send({
        status: "RECUSADO"
      });

    expect(resposta.status).toBe(500);

    expect(resposta.body.mensagem)
      .toBe("Erro interno ao atualizar pagamento");
  });

});


// ======================================================
// FINALIZAÇÃO DOS TESTES
// ======================================================

afterAll(async () => {

  // Limpa o banco de teste
  await pool.query(
    `TRUNCATE TABLE pagamentos, orcamentos
     RESTART IDENTITY CASCADE`
  );

  // Fecha a conexão com o PostgreSQL
  await pool.end();
});