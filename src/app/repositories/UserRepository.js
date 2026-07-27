import User from "../models/User.js";


class UserRepository {
 async findByEmail(email) {
   return await User.findOne({ where: { email } });
 }

 async findByUpdateNumber(data){
  return await User.findOne({ where: data})
 }

 async findById(id) {
   return await User.findByPk(id);
 }

 async findAll () {
  return await User.findAll({
    attributes: ["id", "name", "email", "createdAt", "updatedAt"],
    order: [["createdAt", "ASC"]],
  });
 }

 async create(userData) {
   return await User.create(userData);
 }

 async updatePassword(dataUser){
   const user = await this.findByUpdateNumber(dataUser.update_number)
   if(!user){
    throw new Error('incorrect data')
   }

   const {newNumberUpdate, password} = dataUser
   return await user.update({update_number: newNumberUpdate, password})
 }

 async update(id, userData) {
   const user = await this.findById(id);
   if (!user) {
     throw new Error('incorrect data');
   }
   return await user.update(userData);
 }

 async delete(id) {
   const user = await this.findById(id);
   if (!user) {
     throw new Error('incorrect data');
   }
   return await user.destroy();
 }
}

export default new UserRepository();