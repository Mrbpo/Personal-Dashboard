FROM study-course-video:playwright1.63.0
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
 && python -m playwright install --no-shell chromium \
 && rm -rf /var/lib/apt/lists/*
COPY archive.py /tool/archive.py
COPY interactive-entrypoint.sh /tool/interactive-entrypoint.sh
RUN sed -i 's/\r$//' /tool/interactive-entrypoint.sh \
 && chmod 755 /tool/interactive-entrypoint.sh
ENV DISPLAY=:99 PYTHONUNBUFFERED=1
EXPOSE 6080
ENTRYPOINT ["/tool/interactive-entrypoint.sh"]
