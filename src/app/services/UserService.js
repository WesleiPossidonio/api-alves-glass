import crypto from 'crypto';
import UserRepository from '../repositories/UserRepository.js';

class UserService {
    async registerUser(userData){
        const existingUser = await UserRepository.findByEmail(userData.email);

        if (existingUser) {
            throw new Error('Usuário já existe');
        }

        const updateNumber = crypto.randomInt(100000, 1000000).toString();

        const dataUser = {update_number: updateNumber, ...userData}
        const user = await UserRepository.create(dataUser);
        return user;
    }

    async updateUser(id, userData)  {
        if (userData.update_number && !id) {
            const verificationNumber = await UserRepository.findOneUpdateNumber({
              where: { update_number },
            })

            if (!verificationNumber) {
              return response.status(400).json({ error: 'Invalid update number' })
            }

            const newNumberUpdate = crypto.randomInt(100000, 1000000).toString();
            const dataUser = {
                update_number: userData.update_number, 
                newNumberUpdate,
                password: userData.password
            }

            await UserRepository.updatePassword(dataUser)

        }

        const user = await UserRepository.findById(id);
        if (!user) {
            throw new Error('Usuário não encontrado');
        }

        const updatedUser = await UserRepository.update(id, userData);
        return updatedUser;
    }

    async deleteUser(id) {
        const user = await UserRepository.findById(id);
        if (!user) {
            throw new Error('Usuário não encontrado');
        }

        await UserRepository.delete(id)
    }

    async listUsers (role) {
      if(role !== 'admin') {
        return response.status(403).json({ error: 'Acesso negado. Apenas administradores podem listar usuários.' });
       }

      return UserRepository.findAll();
    }
}

export default new UserService()