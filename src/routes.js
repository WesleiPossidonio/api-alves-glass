import { Router } from 'express';
import BudgetController from './app/controllers/BudgetController.js';
import ClientController from './app/controllers/ClientController.js';
import EmailController from './app/controllers/EmailController.js';
import GoogleSessionController from './app/controllers/GoogleSessionController.js';
import OrderController from './app/controllers/OrderController.js';
import OrderProductsController from './app/controllers/OrderProductsController.js';
import SessionClientController from './app/controllers/SessionClientController.js';
import SessionsController from './app/controllers/SessionsController.js';
import UserController from './app/controllers/UserController.js';
import authMiddlewares from './app/meddleawares/auth.js';
import upload from './config/multer.js';

const routes = new Router();

routes.post('/session/user', SessionsController.store);
routes.post('/session/client', SessionClientController.store);
routes.post('/google-session', GoogleSessionController.store);
routes.get('/check-auth', SessionsController.index);

routes.post('/sendEmail', EmailController.send);
routes.post('/createUser', UserController.store);

routes.use(authMiddlewares);
routes.get('/user/all', UserController.index);
routes.put('/user/:id', UserController.update);
routes.post('/budged', upload.single('file'), BudgetController.store)

routes.post('/client', ClientController.store);
routes.get('/client/all', ClientController.index);
routes.get('/client/me', ClientController.getclientData);
routes.put('/client/:id', ClientController.update);

routes.post('/order', OrderController.store);
routes.get('/order/all', OrderController.index);
routes.get('/order/me', OrderController.show);
routes.patch('/order/:id', OrderController.update);
routes.patch('/orders/:id/products', OrderProductsController.update);
export default routes;
