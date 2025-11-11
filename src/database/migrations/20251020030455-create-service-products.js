'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    queryInterface.createTable('services_products', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        allowNull: false,
        primaryKey: true,
      },
      service_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'order',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      product_name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      quantity: {
        type: Sequelize.STRING,
        allowNull: false
      },
      price: {
        type: Sequelize.STRING,
        allowNull: false
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('services_products');
  }
};
