# The coding agent's shell, for an Azure Container Apps custom container session pool.
#
# Every session starts with what most data and document work needs, so the agent does not spend its first minutes
# installing: LibreOffice (to recalculate a workbook and render a deck or document to PDF), poppler (PDF to page
# images, so it can check its slides by eye), Chromium (screenshots), pandoc, graphviz, and the usual Python
# packages for data, Office files, PDFs and charts. Anything else the agent installs itself, at runtime: Python
# packages with pip, system packages with `apt-get install`, which runs as root through sudo (for apt only).
# A runtime install lasts for the session's life.
FROM python:3.12-slim
# Installing as root is expected while the image is built; pip's warning about it and its upgrade notice are noise.
ENV PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1
# A build has no terminal, so apt is told not to look for one to ask questions on (it falls back anyway, noisily).
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git ca-certificates curl sudo zip unzip jq sqlite3 \
       chromium \
       libreoffice-impress libreoffice-calc-nogui libreoffice-writer-nogui poppler-utils pandoc graphviz \
       fonts-dejavu-core fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 agent \
    && printf 'Defaults env_keep += "DEBIAN_FRONTEND"\nagent ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt\n' > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent \
    && for c in apt-get apt; do printf '#!/bin/sh\nexec sudo -n /usr/bin/%s "$@"\n' "$c" > /usr/local/bin/$c; \
       chmod 755 /usr/local/bin/$c; done \
    && mkdir /work && chown agent /work

# In the image's Python; each project's .venv is made with --system-site-packages, so it sees these and pip can
# still add more on top.
RUN pip install --no-cache-dir \
    pandas numpy scipy pyarrow \
    openpyxl xlsxwriter xlrd python-pptx python-docx \
    pypdf pdfplumber reportlab \
    matplotlib seaborn pillow \
    requests beautifulsoup4 lxml jinja2 markdown tabulate

# What the agent's sessions installed and recorded: `python python/19_coding_agent.py --export-installed
# examples/coding-sandbox` writes these lists, and the next build includes them.
COPY extra-apt.txt extra-requirements.txt /tmp/extra/
RUN apt-get update \
    && (grep -hv '^[[:space:]]*#' /tmp/extra/extra-apt.txt | xargs -r /usr/bin/apt-get install -y --no-install-recommends) \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r /tmp/extra/extra-requirements.txt

COPY server.py /app/server.py
USER agent
ENV WORK_DIR=/work HOST=0.0.0.0 PORT=8080 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
EXPOSE 8080
CMD ["python", "/app/server.py"]
