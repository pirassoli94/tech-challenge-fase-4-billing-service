// Importa o Express para criar o servidor e as rotas da API
const express = require("express");
const crypto = require("crypto");
const client = require("prom-client");

// Importa a biblioteca usada para comunicação com o RabbitMQ
const amqp = require("amqplib");

// Carrega as configurações armazenadas no arquivo .env
require("dotenv").config({
  quiet: true
});

// Importa a ferramenta que conecta o Node.js ao PostgreSQL
const { Pool } = require("pg");

// Importa o SDK do Mercado Pago
const {
  MercadoPagoConfig,
  Preference
} = require("mercadopago");

// Configura o cliente do Mercado Pago com o Access Token
const clienteMercadoPago = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN
});

// Cliente usado para criar preferências do Checkout Pro
const preferenciaMercadoPago = new Preference(
  clienteMercadoPago
);

// ======================================================
// CONFIGURAÇÃO DO POSTGRESQL
// ======================================================

// Configura a conexão com o banco exclusivo do Billing Service
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

// Testa se o Billing Service consegue acessar o PostgreSQL
pool.query("SELECT NOW()")
  .then(() => {
    console.log("Conexão com o PostgreSQL realizada com sucesso!");
  })
  .catch((erro) => {
    console.error(
      "Erro ao conectar com o PostgreSQL:",
      erro.message
    );
  });


// ======================================================
// CONFIGURAÇÃO DO EXPRESS
// ======================================================

// Cria a aplicação usando o Express
const app = express();

// Define a porta do Billing Service
const porta = 3001;

// Permite que a API receba dados no formato JSON
app.use(express.json());

// Registro Prometheus exclusivo do microsservico
const metricsRegistry = new client.Registry();

client.collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "billing_service_"
});

const httpRequestsTotal = new client.Counter({
  name: "billing_service_http_requests_total",
  help: "Total de requisicoes HTTP",
  labelNames: [
    "method",
    "route",
    "status_code"
  ],
  registers: [metricsRegistry]
});

const httpRequestDuration =
  new client.Histogram({
    name:
      "billing_service_http_request_duration_seconds",
    help:
      "Duracao das requisicoes HTTP em segundos",
    labelNames: [
      "method",
      "route",
      "status_code"
    ],
    buckets: [
      0.01,
      0.05,
      0.1,
      0.3,
      0.5,
      1,
      2,
      5
    ],
    registers: [metricsRegistry]
  });

// Correlacao, medicao e logs estruturados
app.use((req, res, next) => {
  const correlationId =
    req.get("X-Correlation-ID") ||
    crypto.randomUUID();

  req.correlationId = correlationId;

  res.set(
    "X-Correlation-ID",
    correlationId
  );

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const seconds =
      Number(
        process.hrtime.bigint() - start
      ) / 1_000_000_000;

    const route =
      req.route?.path ||
      req.path ||
      "unknown";

    const labels = {
      method: req.method,
      route,
      status_code: String(
        res.statusCode
      )
    };

    httpRequestsTotal.inc(labels);

    httpRequestDuration.observe(
      labels,
      seconds
    );

    console.log(
      JSON.stringify({
        timestamp:
          new Date().toISOString(),
        level: "info",
        service:
          "billing_service",
        correlation_id:
          correlationId,
        method: req.method,
        route,
        status_code:
          res.statusCode,
        duration_ms:
          Number(
            (seconds * 1000).toFixed(2)
          )
      })
    );
  });

  next();
});

// Metricas no formato Prometheus
app.get("/metrics", async (req, res) => {
  res.set(
    "Content-Type",
    metricsRegistry.contentType
  );

  res.end(
    await metricsRegistry.metrics()
  );
});


// ======================================================
// CONFIGURAÇÃO DO RABBITMQ
// ======================================================

// Canal compartilhado para enviar e receber mensagens
let canalRabbitMQ;

// Permite fornecer um canal RabbitMQ simulado durante os testes
function definirCanalRabbitMQ(canal) {
  canalRabbitMQ = canal;
}

// Conecta o Billing Service ao RabbitMQ
async function conectarRabbitMQ() {
  try {
    const conexao = await amqp.connect(
      process.env.RABBITMQ_URL
    );

    canalRabbitMQ = await conexao.createChannel();

    // Fila utilizada para informar pagamentos confirmados
    await canalRabbitMQ.assertQueue(
      "pagamento_confirmado",
      {
        durable: true
      }
    );

    // Fila utilizada pelo Execution Service para informar uma falha
    await canalRabbitMQ.assertQueue(
      "execucao_falhou",
      {
        durable: true
      }
    );

    // Fica aguardando mensagens de falha de execução
    canalRabbitMQ.consume(
      "execucao_falhou",
      async (msg) => {

        if (msg) {
          try {
            // Converte a mensagem recebida para JSON
            const mensagem = JSON.parse(
              msg.content.toString()
            );

            console.log(
              "Billing recebeu EXECUCAO_FALHOU:"
            );

            console.log(mensagem);

            // Procura o pagamento confirmado relacionado
            // à ordem que teve falha na execução
            const resultado = await pool.query(
              `UPDATE pagamentos
               SET status = 'CANCELAMENTO_PENDENTE'
               WHERE orcamento_id IN (
                 SELECT id
                 FROM orcamentos
                 WHERE ordem_id = $1
               )
               AND status = 'CONFIRMADO'
               RETURNING *`,
              [mensagem.ordem_id]
            );

            console.log(
              "Pagamentos compensados:",
              resultado.rows
            );

            // Informa ao RabbitMQ que a mensagem foi processada
            canalRabbitMQ.ack(msg);

          } catch (erro) {
            console.error(
              "Erro ao processar EXECUCAO_FALHOU:",
              erro.message
            );
          }
        }
      }
    );

    console.log(
      "Conexão com o RabbitMQ realizada com sucesso!"
    );

  } catch (erro) {
    console.error(
      "Erro ao conectar com o RabbitMQ:",
      erro.message
    );
  }
}

// Inicia a conexão com o RabbitMQ
// Durante os testes automatizados, não abre conexão real com o RabbitMQ
if (process.env.NODE_ENV !== "test") {
  conectarRabbitMQ();
}


// ======================================================
// ROTA DE TESTE
// ======================================================

// Verifica se o Billing Service está funcionando

// Consulta um pagamento diretamente no Mercado Pago
async function consultarPagamentoMercadoPago(mercadoPagoId) {
  const resposta = await fetch(
    `https://api.mercadopago.com/v1/payments/${mercadoPagoId}`,
    {
      headers: {
        Authorization:
          `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`
      }
    }
  );

  if (!resposta.ok) {
    const detalhe = await resposta.text();

    throw new Error(
      `Mercado Pago respondeu ${resposta.status}: ${detalhe}`
    );
  }

  return resposta.json();
}

// Pesquisa pagamentos pela referencia interna do Billing
async function buscarPagamentoMercadoPagoPorReferencia(
  pagamentoId
) {
  const url =
    "https://api.mercadopago.com/v1/payments/search" +
    `?external_reference=${encodeURIComponent(pagamentoId)}` +
    "&sort=date_created&criteria=desc";

  const resposta = await fetch(url, {
    headers: {
      Authorization:
        `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`
    }
  });

  if (!resposta.ok) {
    const detalhe = await resposta.text();

    throw new Error(
      `Mercado Pago respondeu ${resposta.status}: ${detalhe}`
    );
  }

  const dados = await resposta.json();

  if (!dados.results || dados.results.length === 0) {
    return null;
  }

  return (
    dados.results.find(
      (pagamento) => pagamento.status === "approved"
    ) ||
    dados.results[0]
  );
}

// Converte o status externo para o status interno
function converterStatusMercadoPago(status) {
  if (status === "approved") {
    return "CONFIRMADO";
  }

  if (
    status === "rejected" ||
    status === "cancelled" ||
    status === "refunded" ||
    status === "charged_back"
  ) {
    return "RECUSADO";
  }

  return "PENDENTE";
}

// Publica a confirmacao no RabbitMQ
function publicarPagamentoConfirmado(pagamento) {
  if (!canalRabbitMQ) {
    console.warn(
      "RabbitMQ indisponivel para publicar PAGAMENTO_CONFIRMADO"
    );

    return;
  }

  const mensagem = {
    tipo: "PAGAMENTO_CONFIRMADO",
    pagamento_id: pagamento.id,
    orcamento_id: pagamento.orcamento_id,
    valor: pagamento.valor
  };

  canalRabbitMQ.sendToQueue(
    "pagamento_confirmado",
    Buffer.from(JSON.stringify(mensagem)),
    {
      persistent: true
    }
  );

  console.log(
    "Mensagem PAGAMENTO_CONFIRMADO enviada para o RabbitMQ"
  );
}

// Atualiza o PostgreSQL com o retorno do Mercado Pago
async function processarPagamentoMercadoPago(
  pagamentoMercadoPago
) {
  const pagamentoId = Number(
    pagamentoMercadoPago.external_reference
  );

  if (!Number.isInteger(pagamentoId) || pagamentoId <= 0) {
    throw new Error(
      "Pagamento sem external_reference valida"
    );
  }

  const consulta = await pool.query(
    "SELECT * FROM pagamentos WHERE id = $1",
    [pagamentoId]
  );

  if (consulta.rows.length === 0) {
    throw new Error(
      `Pagamento interno ${pagamentoId} nao encontrado`
    );
  }

  const statusAnterior = consulta.rows[0].status;

  const statusNovo = converterStatusMercadoPago(
    pagamentoMercadoPago.status
  );

  const atualizacao = await pool.query(
    `UPDATE pagamentos
     SET status = $1,
         referencia_externa = $2
     WHERE id = $3
     RETURNING *`,
    [
      statusNovo,
      String(pagamentoMercadoPago.id),
      pagamentoId
    ]
  );

  const pagamento = atualizacao.rows[0];

  if (
    statusNovo === "CONFIRMADO" &&
    statusAnterior !== "CONFIRMADO"
  ) {
    publicarPagamentoConfirmado(pagamento);
  }

  return {
    pagamento,
    mercado_pago: {
      id: pagamentoMercadoPago.id,
      status: pagamentoMercadoPago.status,
      status_detail:
        pagamentoMercadoPago.status_detail
    }
  };
}

app.get("/", (req, res) => {
  res.json({
    mensagem: "Billing Service está funcionando!"
  });
});


// ======================================================
// ORÇAMENTOS
// ======================================================

// Lista todos os orçamentos
app.get("/orcamentos", async (req, res) => {
  try {
    const resultado = await pool.query(
      "SELECT * FROM orcamentos ORDER BY id"
    );

    res.json(resultado.rows);

  } catch (erro) {
    console.error(
      "Erro ao listar orçamentos:",
      erro.message
    );

    res.status(500).json({
      mensagem:
        "Erro interno ao listar orçamentos"
    });
  }
});


// Busca um orçamento pelo ID
app.get("/orcamentos/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const resultado = await pool.query(
      "SELECT * FROM orcamentos WHERE id = $1",
      [id]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({
        mensagem: "Orçamento não encontrado"
      });
    }

    res.json(resultado.rows[0]);

  } catch (erro) {
    console.error(
      "Erro ao buscar orçamento:",
      erro.message
    );

    res.status(500).json({
      mensagem:
        "Erro interno ao buscar orçamento"
    });
  }
});


// Cria um novo orçamento
app.post("/orcamentos", async (req, res) => {
  const {
    ordem_id,
    valor,
    descricao
  } = req.body;

  // Valida os campos obrigatórios
  if (!ordem_id || !valor || !descricao) {
    return res.status(400).json({
      mensagem:
        "Ordem, valor e descrição são obrigatórios"
    });
  }

  try {

    // Consulta o OS Service para verificar
    // se a ordem realmente existe
    const respostaOS = await fetch(
      `${process.env.OS_SERVICE_URL}/ordens/${ordem_id}`
    );

    // Não permite orçamento para uma ordem inexistente
    if (respostaOS.status === 404) {
      return res.status(400).json({
        mensagem:
          "Não é possível criar o orçamento: ordem não encontrada"
      });
    }

    // Trata outros erros vindos do OS Service
    if (!respostaOS.ok) {
      return res.status(502).json({
        mensagem:
          "Erro ao consultar o OS Service"
      });
    }

    // Salva o orçamento no PostgreSQL
    const resultado = await pool.query(
      `INSERT INTO orcamentos
       (ordem_id, valor, descricao)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [
        ordem_id,
        valor,
        descricao
      ]
    );

    res.status(201).json(
      resultado.rows[0]
    );

  } catch (erro) {
    console.error(
      "Erro ao criar orçamento:",
      erro.message
    );

    res.status(500).json({
      mensagem:
        "Erro interno ao criar orçamento"
    });
  }
});


// Atualiza o status do orçamento
app.patch(
  "/orcamentos/:id/status",
  async (req, res) => {

    const id = Number(req.params.id);
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        mensagem:
          "O novo status é obrigatório"
      });
    }

    const statusPermitidos = [
      "PENDENTE",
      "APROVADO",
      "RECUSADO"
    ];

    if (!statusPermitidos.includes(status)) {
      return res.status(400).json({
        mensagem: "Status inválido",
        statusPermitidos
      });
    }

    try {
      const resultado = await pool.query(
        `UPDATE orcamentos
         SET status = $1
         WHERE id = $2
         RETURNING *`,
        [
          status,
          id
        ]
      );

      if (resultado.rows.length === 0) {
        return res.status(404).json({
          mensagem:
            "Orçamento não encontrado"
        });
      }

      res.json(resultado.rows[0]);

    } catch (erro) {
      console.error(
        "Erro ao atualizar orçamento:",
        erro.message
      );

      res.status(500).json({
        mensagem:
          "Erro interno ao atualizar orçamento"
      });
    }
  }
);


// ======================================================
// PAGAMENTOS
// ======================================================

// Lista todos os pagamentos
app.get("/pagamentos", async (req, res) => {
  try {
    const resultado = await pool.query(
      "SELECT * FROM pagamentos ORDER BY id"
    );

    res.json(resultado.rows);

  } catch (erro) {
    console.error(
      "Erro ao listar pagamentos:",
      erro.message
    );

    res.status(500).json({
      mensagem:
        "Erro interno ao listar pagamentos"
    });
  }
});


// Busca um pagamento pelo ID
app.get("/pagamentos/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const resultado = await pool.query(
      "SELECT * FROM pagamentos WHERE id = $1",
      [id]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({
        mensagem:
          "Pagamento não encontrado"
      });
    }

    res.json(resultado.rows[0]);

  } catch (erro) {
    console.error(
      "Erro ao buscar pagamento:",
      erro.message
    );

    res.status(500).json({
      mensagem:
        "Erro interno ao buscar pagamento"
    });
  }
});


// Verifica se uma ordem possui pagamento confirmado
app.get(
  "/pagamentos/ordem/:ordemId/confirmado",
  async (req, res) => {

    const ordemId = Number(
      req.params.ordemId
    );

    try {
      const resultado = await pool.query(
        `SELECT pagamentos.*
         FROM pagamentos
         INNER JOIN orcamentos
           ON orcamentos.id =
              pagamentos.orcamento_id
         WHERE orcamentos.ordem_id = $1
           AND pagamentos.status = 'CONFIRMADO'
         ORDER BY pagamentos.id DESC
         LIMIT 1`,
        [ordemId]
      );

      if (resultado.rows.length === 0) {
        return res.status(404).json({
          confirmado: false,
          mensagem:
            "Pagamento confirmado não encontrado para esta ordem"
        });
      }

      res.json({
        confirmado: true,
        pagamento: resultado.rows[0]
      });

    } catch (erro) {
      console.error(
        "Erro ao verificar pagamento:",
        erro.message
      );

      res.status(500).json({
        mensagem:
          "Erro interno ao verificar pagamento"
      });
    }
  }
);


// Registra um novo pagamento
app.post("/pagamentos", async (req, res) => {
  const {
    orcamento_id,
    valor
  } = req.body;

  if (!orcamento_id || !valor) {
    return res.status(400).json({
      mensagem:
        "Orçamento e valor são obrigatórios"
    });
  }

  try {
    const resultado = await pool.query(
      `INSERT INTO pagamentos
       (orcamento_id, valor)
       VALUES ($1, $2)
       RETURNING *`,
      [
        orcamento_id,
        valor
      ]
    );

    res.status(201).json(
      resultado.rows[0]
    );

  } catch (erro) {
    console.error(
      "Erro ao registrar pagamento:",
      erro.message
    );

    res.status(500).json({
      mensagem:
        "Erro interno ao registrar pagamento"
    });
  }
});

// Cria uma preferência de pagamento no Mercado Pago
app.post(
  "/pagamentos/:id/checkout",
  async (req, res) => {
    const id = Number(req.params.id);

    // Verifica se o ID informado é um número válido
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        mensagem: "ID de pagamento inválido"
      });
    }

    // Impede a chamada sem o Access Token configurado
    if (!process.env.MERCADO_PAGO_ACCESS_TOKEN) {
      return res.status(500).json({
        mensagem:
          "Access Token do Mercado Pago não configurado"
      });
    }

    try {
      // Busca o pagamento e o orçamento relacionado
      const resultado = await pool.query(
        `SELECT
           p.id AS pagamento_id,
           p.valor,
           p.status,
           p.orcamento_id,
           o.ordem_id,
           o.descricao
         FROM pagamentos p
         INNER JOIN orcamentos o
           ON o.id = p.orcamento_id
         WHERE p.id = $1`,
        [id]
      );

      if (resultado.rows.length === 0) {
        return res.status(404).json({
          mensagem: "Pagamento não encontrado"
        });
      }

      const pagamento = resultado.rows[0];

      // Só cria checkout para pagamento ainda pendente
      if (pagamento.status !== "PENDENTE") {
        return res.status(400).json({
          mensagem:
            "O checkout só pode ser criado para pagamento pendente",
          statusAtual: pagamento.status
        });
      }

      // Cria a preferência do Checkout Pro
      const preferencia =
        await preferenciaMercadoPago.create({
          body: {
            items: [
              {
                id: String(pagamento.pagamento_id),
                title:
                  `Ordem de serviço ${pagamento.ordem_id}`,
                description: pagamento.descricao,
                quantity: 1,
                currency_id: "BRL",
                unit_price: Number(pagamento.valor)
              }
            ],
            external_reference:
              String(pagamento.pagamento_id),
            metadata: {
              pagamento_id:
                pagamento.pagamento_id,
              orcamento_id:
                pagamento.orcamento_id,
              ordem_id:
                pagamento.ordem_id
            }
          }
        });

      // Devolve os dados necessários para abrir o Checkout Pro
      res.status(201).json({
        mensagem:
          "Preferência de pagamento criada",
        pagamento_id:
          pagamento.pagamento_id,
        preference_id:
          preferencia.id,
        checkout_url:
          preferencia.sandbox_init_point ||
          preferencia.init_point
      });

    } catch (erro) {
      console.error(
        "Erro ao criar preferência no Mercado Pago:",
        erro.message
      );

      res.status(502).json({
        mensagem:
          "Erro ao criar preferência no Mercado Pago",
        detalhe:
          erro.message
      });
    }
  }
);

// Atualiza o status de um pagamento

// Sincroniza manualmente com o Mercado Pago
app.post(
  "/pagamentos/:id/sincronizar",
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        mensagem: "ID de pagamento invalido"
      });
    }

    try {
      const pagamentoMercadoPago =
        await buscarPagamentoMercadoPagoPorReferencia(id);

      if (!pagamentoMercadoPago) {
        return res.status(404).json({
          mensagem:
            "Pagamento nao encontrado no Mercado Pago"
        });
      }

      const resultado =
        await processarPagamentoMercadoPago(
          pagamentoMercadoPago
        );

      res.json({
        mensagem:
          "Pagamento sincronizado com o Mercado Pago",
        ...resultado
      });
    } catch (erro) {
      console.error(
        "Erro ao sincronizar pagamento:",
        erro.message
      );

      res.status(502).json({
        mensagem:
          "Erro ao sincronizar com o Mercado Pago",
        detalhe: erro.message
      });
    }
  }
);

// Webhook de notificacoes do Mercado Pago
app.post(
  "/webhooks/mercado-pago",
  async (req, res) => {
    const mercadoPagoId =
      req.body?.data?.id ||
      req.query["data.id"] ||
      req.query.id;

    if (!mercadoPagoId) {
      return res.status(200).json({
        recebido: true,
        processado: false
      });
    }

    try {
      const pagamentoMercadoPago =
        await consultarPagamentoMercadoPago(
          mercadoPagoId
        );

      const resultado =
        await processarPagamentoMercadoPago(
          pagamentoMercadoPago
        );

      res.status(200).json({
        recebido: true,
        processado: true,
        pagamento: resultado.pagamento
      });
    } catch (erro) {
      console.error(
        "Erro no webhook do Mercado Pago:",
        erro.message
      );

      res.status(500).json({
        recebido: true,
        processado: false,
        detalhe: erro.message
      });
    }
  }
);

app.patch(
  "/pagamentos/:id/status",
  async (req, res) => {

    const id = Number(req.params.id);

    const {
      status,
      referencia_externa
    } = req.body;

    if (!status) {
      return res.status(400).json({
        mensagem:
          "O novo status é obrigatório"
      });
    }

    // Status permitidos no fluxo de pagamento
    const statusPermitidos = [
      "PENDENTE",
      "CONFIRMADO",
      "RECUSADO",
      "CANCELAMENTO_PENDENTE"
    ];

    if (!statusPermitidos.includes(status)) {
      return res.status(400).json({
        mensagem: "Status inválido",
        statusPermitidos
      });
    }

    try {

      // Atualiza o pagamento
      const resultado = await pool.query(
        `UPDATE pagamentos
         SET status = $1,
             referencia_externa =
               COALESCE(
                 $2,
                 referencia_externa
               )
         WHERE id = $3
         RETURNING *`,
        [
          status,
          referencia_externa,
          id
        ]
      );

      if (resultado.rows.length === 0) {
        return res.status(404).json({
          mensagem:
            "Pagamento não encontrado"
        });
      }

      // Se o pagamento foi confirmado,
      // publica o evento no RabbitMQ
      if (
        status === "CONFIRMADO" &&
        canalRabbitMQ
      ) {

        const pagamento =
          resultado.rows[0];

        const mensagem = {
          tipo:
            "PAGAMENTO_CONFIRMADO",
          pagamento_id:
            pagamento.id,
          orcamento_id:
            pagamento.orcamento_id,
          valor:
            pagamento.valor
        };

        canalRabbitMQ.sendToQueue(
          "pagamento_confirmado",
          Buffer.from(
            JSON.stringify(mensagem)
          ),
          {
            persistent: true
          }
        );

        console.log(
          "Mensagem PAGAMENTO_CONFIRMADO enviada para o RabbitMQ"
        );
      }

      res.json(resultado.rows[0]);

    } catch (erro) {
      console.error(
        "Erro ao atualizar pagamento:",
        erro.message
      );

      res.status(500).json({
        mensagem:
          "Erro interno ao atualizar pagamento"
      });
    }
  }
);


// ======================================================
// INICIALIZAÇÃO DO SERVIDOR
// ======================================================

// Só sobe o servidor quando este arquivo é executado diretamente
if (require.main === module) {
  app.listen(porta, () => {
    console.log(
      `Billing Service iniciado na porta ${porta}`
    );
  });
}

// Exporta os componentes necessários para os testes automatizados
module.exports = {
  app,
  pool,
  definirCanalRabbitMQ
};