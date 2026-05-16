# Container image for the predict Lambda.
# Uses the AWS Lambda Python 3.12 base, then installs heavy scientific deps.

FROM public.ecr.aws/lambda/python:3.12

# eccodes is needed by cfgrib; install system package first
RUN dnf install -y eccodes-devel gcc && dnf clean all

WORKDIR ${LAMBDA_TASK_ROOT}

# Copy and install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy handler
COPY handler.py .

CMD ["handler.handler"]
