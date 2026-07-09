# Use official python slim image
FROM python:3.11-slim

# Install system dependencies including Stockfish, FFmpeg (audio processing), and dev tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish \
    ffmpeg \
    portaudio19-dev \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install python packages
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server files and client static assets
COPY server/ /app/server/
COPY client/ /app/client/

# Expose the Flask port (Render will dynamically route HTTP traffic here)
EXPOSE 5174

# Run the application from within the server directory
WORKDIR /app/server
CMD ["python", "app.py"]
