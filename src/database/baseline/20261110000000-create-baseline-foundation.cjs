'use strict'

/**
 * Âncora técnica mínima do baseline canônico. Não cria entidade de domínio, tabela legada ou
 * metadata de migration: sequelize-cli mantém exclusivamente baseline_meta.SequelizeMetaBaseline.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable({ schema: 'baseline_meta', tableName: 'BaselineFoundation' }, {
      version: {
        type: Sequelize.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
    })
  },
  async down(queryInterface) {
    await queryInterface.dropTable({ schema: 'baseline_meta', tableName: 'BaselineFoundation' })
  },
}