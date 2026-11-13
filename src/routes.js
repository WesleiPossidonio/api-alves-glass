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
import SectorController from './app/controllers/SectorController.js'
import MaterialCatalogController from './app/controllers/MaterialCatalogController.js'
import PinCredentialController from './app/controllers/PinCredentialController.js'
import QrStockController from './app/controllers/QrStockController.js'
import StockReportController from './app/controllers/StockReportController.js'
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
routes.get('/stock/qr/:token', QrStockController.publicResolve.bind(QrStockController))
routes.get('/stock/qr/:token/withdrawal', QrStockController.resolve.bind(QrStockController))
routes.get('/stock/material-code/:code/withdrawal', QrStockController.manualResolveByCode.bind(QrStockController))
routes.post('/stock/withdrawals', QrStockController.withdraw.bind(QrStockController))
routes.use(authMiddlewares);
routes.get('/check-auth', (request, response) => response.json({ authenticated: true, userId: request.userId, role: request.userRole, actorType: request.actorType }));
routes.get('/sectors', SectorController.index.bind(SectorController))
routes.get('/sectors/:sectorId/warehouses', SectorController.warehouses.bind(SectorController))
routes.put('/users/:userId/sectors/:sectorId', requireAdmin, SectorController.grant.bind(SectorController))
routes.delete('/users/:userId/sectors/:sectorId', requireAdmin, SectorController.revoke.bind(SectorController))
routes.route('/warehouses/:warehouseId/categories').get(MaterialCatalogController.categories.bind(MaterialCatalogController)).post(MaterialCatalogController.categories.bind(MaterialCatalogController))
routes.route('/categories/:id').patch(MaterialCatalogController.category.bind(MaterialCatalogController))
routes.route('/categories/:categoryId/subcategories').get(MaterialCatalogController.subcategories.bind(MaterialCatalogController)).post(MaterialCatalogController.subcategories.bind(MaterialCatalogController))
routes.route('/subcategories/:id').patch(MaterialCatalogController.subcategory.bind(MaterialCatalogController))
routes.route('/warehouses/:warehouseId/materials').get(MaterialCatalogController.materials.bind(MaterialCatalogController)).post(MaterialCatalogController.materials.bind(MaterialCatalogController))
routes.route('/materials/:id').get(MaterialCatalogController.material.bind(MaterialCatalogController)).patch(MaterialCatalogController.material.bind(MaterialCatalogController))
routes.get('/reports/stock', requireUser, StockReportController.summary.bind(StockReportController))
routes.get('/reports/stock/statement', requireUser, StockReportController.statement.bind(StockReportController))
routes.post('/materials/:materialId/qr-token', requireAdmin, QrStockController.issue.bind(QrStockController))
routes.delete('/materials/:materialId/qr-token', requireAdmin, QrStockController.revoke.bind(QrStockController))
routes.post('/users/:userId/pin', requireAdmin, PinCredentialController.set.bind(PinCredentialController))
routes.put('/users/:userId/pin', requireAdmin, PinCredentialController.set.bind(PinCredentialController))
routes.delete('/users/:userId/pin', requireAdmin, PinCredentialController.revoke.bind(PinCredentialController))
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
