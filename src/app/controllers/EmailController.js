import nodemailer from 'nodemailer';
import * as Yup from 'yup';
import dotenv from 'dotenv';
dotenv.config();

class EmailController {
  async send(request, response) {
    const schema = Yup.object().shape({
      name: Yup.string().required(),
      email: Yup.string().email().required(),
      phone: Yup.string().required(),
      subject_text: Yup.string().required(),
    });

    try {
      await schema.validate(request.body, { abortEarly: false });
    } catch (err) {
      return response.status(400).json({ error: err.errors });
    }

    const { name, email, numberPhone, subject_text } = request.body;

    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_PASS,
        },
      });

      await transporter.sendMail({
        from: `"Site Alves Glass" <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER, // seu email (recebe tudo)
        subject: ` <strong>Site </strong> - Nova mensagem de ${name}`,
        html: `
    <h2>Nova mensagem do site</h2>
    <p><strong>Nome:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Telefone:</strong> ${numberPhone}</p>
    <p><strong>Menssagem:</strong></p>
    <p>${subject_text}</p>
  `,
        replyTo: email, // 🔥 ESSENCIAL
      });

      return response.status(200).json({
        message: 'Email enviado com sucesso!',
      });
    } catch (err) {
      console.log(err);

      return response.status(500).json({
        error: 'Erro ao enviar email',
      });
    }
  }
}

export default new EmailController();
