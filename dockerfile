
FROM node:23.5.0-alpine

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn install --production

COPY . .

EXPOSE 3000

CMD ["yarn", "start"]
