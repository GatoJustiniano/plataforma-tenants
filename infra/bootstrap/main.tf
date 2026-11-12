# Bootstrap: crea el bucket S3 donde viven los estados de IaC de la plataforma y de cada tenant.
# Este root usa estado LOCAL a propósito (no puede guardarse en el bucket que él mismo crea).
# Se aplica una sola vez por cuenta.

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = {
      Proyecto    = "asistencia"
      Componente  = "plataforma"
      Herramienta = "terraform"
    }
  }
}

variable "aws_account_id" {
  type    = string
  default = "207381449073"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

locals {
  bucket = "asistencia-iac-estado-${var.aws_account_id}"
}

resource "aws_s3_bucket" "estado" {
  bucket = local.bucket
  tags   = { Name = local.bucket }
}

# Versionado: permite recuperar un estado anterior si uno se corrompe
resource "aws_s3_bucket_versioning" "estado" {
  bucket = aws_s3_bucket.estado.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Cifrado en reposo: los estados contienen ids de recursos y valores sensibles
resource "aws_s3_bucket_server_side_encryption_configuration" "estado" {
  bucket = aws_s3_bucket.estado.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "estado" {
  bucket                  = aws_s3_bucket.estado.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Solo acceso por HTTPS
resource "aws_s3_bucket_policy" "estado" {
  bucket     = aws_s3_bucket.estado.id
  depends_on = [aws_s3_bucket_public_access_block.estado]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SoloTLS"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.estado.arn, "${aws_s3_bucket.estado.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Las versiones antiguas de los estados se borran a los 90 días
resource "aws_s3_bucket_lifecycle_configuration" "estado" {
  bucket = aws_s3_bucket.estado.id
  rule {
    id     = "versiones-antiguas"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

output "bucket_estado" {
  value = aws_s3_bucket.estado.bucket
}
