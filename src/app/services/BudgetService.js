import Budget from '../models/Budget.js';
import UserRepository from '../repositories/UserRepository.js';
import StorageService from './StorageService.js';

class BudgetService {
  async createBudget(budgetData, idAdmin, filePdf) {
    try {
      const user = await UserRepository.findById(idAdmin);
      if(!user) {
          throw new Error('Acesso negado. Usuário não autorizado a criar orçamento');
      }

      let pdfName = null

      if (filePdf) {
        pdfName = await StorageService.upload({
          file: filePdf,
          folder: 'budgets/2026'
        })
      }

      const budget = await Budget.create({
        ...budgetData, pdf_object_name: pdfName
      });
      return budget;
    } catch (error) {
      console.error('Erro ao criar orçamento:', error);
      throw new Error('Erro ao criar orçamento.');
    }
  }

  async getBudgetByClientId(clientId) {
    try {
      const budgets = await Budget.findAll({ where: { client_id: clientId } });

      if (!budgets || budgets.length === 0) {
        throw new Error('Algum dos dados não foi encontrado.');
      }

      return budgets;
    } catch (error) {
      throw new Error('Erro ao buscar orçamento.');
      console.error('Erro ao buscar orçamento:', error);
    }
  }

  async getBudgetById(id) {
    try {
      const budget = await Budget.findByPk(id);

      if (!budget) {
        throw new Error('Algum dos dados não foi encontrado.');
      }

      return budget;
    } catch (error) {
      throw new Error('Erro ao buscar orçamento.');
      console.error('Erro ao buscar orçamento:', error);
    }
  }

  async updateBudget(budgetId, updateData, idAdmin) {
    try {
      const user = await UserRepository.findById(idAdmin);
      const budget = await Budget.findByPk(budgetId);

      if(!user) {
          throw new Error('Acesso negado. Usuário não autorizado a atualizar orçamento');
      }

      if (!budget) {
        throw new Error('Orçamento não encontrado');
      }

      const dataBudget = {
        client_id: updateData.client_id,
        budget_number: updateData.budget_number,
        status_description: updateData.status_description,
        status: updateData.status,
      };

      await Budget.update(dataBudget, { where: { id: budgetId } });

    } catch (error) {
      console.error('Erro ao atualizar orçamento:', error);
      throw new Error('Erro ao atualizar orçamento.');
    }
  }

  async deleteBudget(budgetId, idAdmin) {
    try {
      const user = await UserRepository.findById(idAdmin);
      const budget = await Budget.findByPk(budgetId);
      if(!user) {
          throw new Error('Acesso negado. Usuário não autorizado a deletar orçamento');
      }

      if (!budget) {
        throw new Error('Orçamento não encontrado');
      }

      await Budget.destroy({ where: { id: budgetId } });

    } catch (error) {
      console.error('Erro ao deletar orçamento:', error);
      throw new Error('Erro ao deletar orçamento.');
    }
  }
}

export default new BudgetService();
