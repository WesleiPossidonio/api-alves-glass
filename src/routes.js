import { Router } from 'express';
import BudgetController from './app/controllers/BudgetController.js';
import ClientController from './app/controllers/ClientController.js';
import EmailController from './app/controllers/EmailController.js';
import GoogleSessionController from './app/controllers/GoogleSessionController.js';
import OrderController from './app/controllers/OrderController.js';
import OrderProductsController from './app/controllers/OrderProductsController.js';
import SessionClientController from './app/controllers/SessionClientController.js';
import SessionsController from './app/controllers/SessionsController.js';
import SessionLifecycleController from './app/controllers/SessionLifecycleController.js';
import UserController from './app/controllers/UserController.js';
import authMiddlewares from './app/meddleawares/auth.js';
import upload from './config/multer.js';
import { createAuthRateLimit } from './app/meddleawares/authRateLimit.js'
import { requireAdmin, requireClient, requireUser } from './app/meddleawares/authorize.js'
import { requireOwner } from './app/meddleawares/ownership.js'

const routes = new Router();
const userLoginRateLimit = createAuthRateLimit({ max: 5 })
const clientLoginRateLimit = createAuthRateLimit({ max: 5 })
const googleLoginRateLimit = createAuthRateLimit({ max: 10 })
const refreshRateLimit = createAuthRateLimit({ max: 30 })

routes.post('/session/user', userLoginRateLimit, SessionsController.store);
routes.post('/session/client', clientLoginRateLimit, SessionClientController.store);
routes.post('/google-session', googleLoginRateLimit, GoogleSessionController.store);
routes.post('/session/refresh', refreshRateLimit, SessionLifecycleController.refresh.bind(SessionLifecycleController));
routes.post('/session/logout', SessionLifecycleController.logout.bind(SessionLifecycleController));


routes.post('/sendEmail', EmailController.send);
routes.use(authMiddlewares);
routes.get('/check-auth', (request, response) => response.json({ authenticated: true, userId: request.userId, role: request.userRole, actorType: request.actorType }));
routes.post('/createUser', requireAdmin, UserController.store);
routes.get('/user/all', requireAdmin, UserController.index);
routes.put('/user/:id', requireUser, requireOwner({ roles: ['admin'], resourceType: 'user' }), UserController.update);
routes.post('/budged', requireAdmin, upload.single('file'), BudgetController.store)

routes.post('/client', requireAdmin, ClientController.store);
routes.get('/client/all', requireAdmin, ClientController.index);
routes.get('/client/me', requireClient, ClientController.getclientData);
routes.put('/client/:id', requireAdmin, ClientController.update);

routes.post('/order', requireAdmin, OrderController.store);
routes.get('/order/all', requireAdmin, OrderController.index);
routes.get('/order/me', requireClient, OrderController.show);
routes.patch('/order/:id', requireAdmin, OrderController.update);
routes.patch('/orders/:id/products', requireAdmin, OrderProductsController.update);
export default routes;
