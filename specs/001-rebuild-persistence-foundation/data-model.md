# Feature 001 — Contrato de persistência vigente

Não há modelo de baseline nesta feature vigente. A aplicação usa PostgreSQL 16, Sequelize 6 e
Sequelize CLI convencional; metadata `public.SequelizeMeta`. As tabelas e constraints resultam das
migrations em `src/database/migrations/` e dos Models registrados em `src/database/index.js`.

Service/use case controla a unidade transacional; Repositories recebem e propagam `transaction`;
Models representam persistência e associações. Mudanças futuras são migrations aditivas novas,
validadas em banco local descartável. Não editar migrations já aplicadas.

O modelo técnico antigo do baseline customizado foi removido deste documento para evitar instrução
ambígua; sua substituição está registrada na spec/plano e no histórico Git.