import Budget from '../models/Budget';

class BudgetRepository {
  async findById(id) {
    return await Budget.findByPk(id);
  }

  async create(budgetData) {
    return await Budget.create(budgetData);
  }

  async update(id, budgetData) {
    const budget = await this.findById(id);
    if (!budget) {
      throw new Error('Budget not found');
    }
    return await budget.update(budgetData);
  }

  async delete(budget) {
    return await budget.destroy();
  }
}

export default new BudgetRepository();