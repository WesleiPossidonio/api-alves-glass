import Category from "../models/Category";

class CategoryRepository {
  async create (categoryData) {
    return Category.create(categoryData);
  }

  async findAll () {
    return Category.findAll();
  }

  async update (id, categoryData) {
    return Category.update(categoryData, {
      where: { id },
    });
  }

  async delete (id) {
    return Category.destroy({
      where: { id },
    });
  }

}

export default new CategoryRepository()