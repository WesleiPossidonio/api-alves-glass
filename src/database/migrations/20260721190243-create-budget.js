'use strict';

/** @type {import('sequelize-cli').Migration} */
export default {
  async up (queryInterface, Sequelize) {
     queryInterface.createTable('budget', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        allowNull: false,
        primaryKey: true,
      },
      client_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'client',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      name_budget: {
        type: Sequelize.STRING,
        allowNull: false
      },
      description_budget: {
        type: Sequelize.STRING,
        allowNull: false
      },
      expiration_date: {
        type: Sequelize.DATE,
        allowNull: false
      },
      total_value: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: false
       },
      pdf_object_name: {
         type: Sequelize.STRING,
         allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
     })
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('budget');
  }
};
