import { Router } from 'express'
import SessionsController from './app/controllers/SessionsController.js';
import UserController from './app/controllers/UserController.js';
import ClientController from './app/controllers/ClientController.js';
import OrderController from './app/controllers/OrderController.js';

const routes = new Router()

routes.post('/session', SessionsController.store)
routes.get('/check-auth', SessionsController.index)
routes.post('/createUser', UserController.store)

// routes.use(authMiddlewares)
routes.get('/getUser', UserController.index)
routes.post('/createClient', ClientController.store)
routes.get('/getClient', ClientController.index)

routes.post('/createOrderProducts', OrderController.store)
routes.get('/getListOrderProducts', OrderController.index)
routes.put('/updateListOrder', OrderController.index)

export default routes;