# Usamos una imagen ligera de Node.js 20 LTS
FROM node:20-alpine

# Instalamos dependencias del sistema necesarias para compilar módulos de Node si los hay
RUN apk add --no-cache git python3 make g++

# Directorio de trabajo en el contenedor
WORKDIR /app

# Copiamos primero los archivos de dependencias para aprovechar la caché de Docker
COPY package.json ./
COPY yarn.lock ./

# Instalamos todas las dependencias (usaremos npm cache o la instalación normal)
RUN npm install --legacy-peer-deps

# Copiamos el resto del código del proyecto
COPY . .

# Exponemos el puerto que usa nuestra API
EXPOSE 3000

# Comando por defecto para iniciar nuestro servidor cuando el contenedor se levante
CMD ["npm", "run", "start"]
