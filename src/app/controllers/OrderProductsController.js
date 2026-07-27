import validator from 'validator';
import * as Yup from 'yup';
import OrderProductService from '../services/OrderProductService.js';

const sanitizeInput = (data) => {
  const sanitized = {}

  for (const key of Object.keys(data)) {
    const value = data[key]

    if (typeof value === "string") {
      if (["phone", "cep"].includes(key)) {
        sanitized[key] = value.trim()
      } else {
        sanitized[key] = validator.escape(value.trim())
      }
    } else {
      sanitized[key] = value
    }
  }

  return sanitized
}

class OrderProductsController {
    async update(request, response) {
        const schema = Yup.object().shape({
            order_id: Yup.string().uuid().required(),
            quantity: Yup.number().optional(),
            unit_price: Yup.number().optional(),
            product_name: Yup.string().optional(),
        })

        const sanitizedBody = sanitizeInput(request.body)

        try {
          await schema.validate(sanitizedBody, { abortEarly: false })
        } catch (err) {
          return response.status(400).json({ error: err.errors })
        }

        const { id } = request.params

        const { order_id, quantity, unit_price, product_name } = sanitizedBody

        const dataOrderProduct = {
            order_id,
            quantity,
            unit_price,
            product_name
        }

        try {
            await OrderProductService.updateOrderProduct({id, productData: dataOrderProduct}, request.transaction)
            return response.status(200).json({ message: 'Order product updated successfully'})
        } catch (error) {
            return response.status(500).json({ error: 'Erro ao atualizar produto do pedido.', details: error.message })
        }




    }
}

export default new OrderProductsController()
