FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY radarx ./radarx

EXPOSE 8000
CMD ["uvicorn", "radarx.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
