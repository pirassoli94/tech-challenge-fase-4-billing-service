# billing-service

Microsservico da Fase 4 do Tech Challenge SOAT.

## Execucao local

`ash
npm ci
npm test -- --coverage
node index.js
`

## Docker

`ash
docker build -t billing-service:1.0 .
docker run --env-file .env.docker -p 3001:3001 billing-service:1.0
`

## Kubernetes

Os manifestos estao em k8s/. Substitua os valores SUBSTITUIR antes do deploy.

`ash
kubectl apply -f k8s/
kubectl rollout status deployment/billing-service
`

## CI/CD

O workflow .github/workflows/ci-cd.yml executa instalacao, testes com cobertura minima de 80%, upload do relatorio e build Docker. O deploy em Kubernetes e habilitado quando o secret KUBE_CONFIG estiver configurado no GitHub.

## Cobertura

A evidencia local esta no arquivo cobertura-billing.txt.

## Seguranca

Arquivos .env, .env.docker, .env.test, 
ode_modules/ e coverage/ nao sao versionados.