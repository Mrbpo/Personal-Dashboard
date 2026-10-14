FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir playwright==1.63.0 yt-dlp==2026.8.19 \
 && python -m playwright install --with-deps --only-shell chromium
WORKDIR /tool
COPY archive.py server-lti-probe.py /tool/
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/tool/archive.py"]
