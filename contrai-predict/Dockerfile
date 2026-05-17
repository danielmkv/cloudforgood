FROM public.ecr.aws/lambda/python:3.12

# Install runtime system libraries that cfgrib/eccodes/rasterio need
RUN dnf install -y \
        expat \
        libxml2 \
    && dnf clean all

# Python deps
COPY requirements.txt ${LAMBDA_TASK_ROOT}
RUN pip install --no-cache-dir -r requirements.txt

# Lambda handler
COPY lambda_predict.py ${LAMBDA_TASK_ROOT}

CMD ["lambda_predict.lambda_handler"]