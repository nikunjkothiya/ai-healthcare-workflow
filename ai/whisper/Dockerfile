FROM ubuntu:22.04

RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    cmake \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /whisper.cpp

# Clone and build whisper.cpp
RUN git clone https://github.com/ggerganov/whisper.cpp.git . && \
    make

# Models are mounted from host via docker-compose volume (./models/whisper:/models/whisper)
# No model download here - place models in the project's models/whisper/ directory.
# See models/README.md for instructions.

WORKDIR /audio

CMD ["tail", "-f", "/dev/null"]
