# Use lightweight Alpine Node.js base image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy the zero-dependency gateway server code
COPY server.js .

# Default port for Google Cloud Run is 8080, but GCP will override PORT env variable anyway
ENV PORT=8080
EXPOSE 8080

# Run the Node server directly
CMD ["node", "server.js"]
