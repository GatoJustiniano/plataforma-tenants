# EC2 de la plataforma (plano de control). Por ahora aloja el monitoreo: Prometheus,
# blackbox_exporter y Grafana, instalados con Ansible. Más adelante también el portal y el worker.
#
# Ansible no puede ejecutarse como nodo de control en Windows, así que el playbook viaja
# empaquetado a S3 y la propia instancia lo ejecuta en modo local (ansible-playbook -c local).

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  backend "s3" {
    bucket       = "asistencia-iac-estado-207381449073"
    key          = "plataforma/portal.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
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

locals {
  prefijo     = "asistencia-plataforma"
  ssm_prefijo = "/asistencia/plataforma"
  bucket      = "asistencia-iac-estado-${var.aws_account_id}"
  catalogo    = jsondecode(file("${path.module}/../../catalogo/planes.json"))
  # Variables que recibe el playbook (sin secretos: esos los lee la instancia desde SSM)
  vars_ansible = {
    region            = var.region
    ssm_prefijo       = local.ssm_prefijo
    alertas           = local.catalogo.comunes.alertas
    intervalos_planes = { for p in local.catalogo.planes : p.id => p.monitoreo.intervalo_metricas_s }
    retencion_dias    = var.retencion_metricas_dias
  }
}

# ---------- Red compartida (infra/red) ----------

data "aws_vpc" "compartida" {
  tags = { Rol = "red-tenants" }
}

data "aws_subnets" "publicas" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.compartida.id]
  }
  tags = { Tipo = "publica" }
}

data "aws_security_group" "plataforma" {
  vpc_id = data.aws_vpc.compartida.id
  tags   = { Rol = "sg-plataforma" }
}

# Grafana solo es accesible desde las IPs de administración
resource "aws_vpc_security_group_ingress_rule" "grafana" {
  for_each          = toset(var.cidrs_admin)
  security_group_id = data.aws_security_group.plataforma.id
  description       = "Grafana desde administracion"
  ip_protocol       = "tcp"
  from_port         = 3000
  to_port           = 3000
  cidr_ipv4         = each.value
}

# ---------- Secretos ----------

resource "random_password" "grafana_admin" {
  length  = 24
  special = false
}

resource "aws_ssm_parameter" "grafana_admin" {
  name        = "${local.ssm_prefijo}/grafana-admin"
  description = "Clave del usuario admin de Grafana"
  type        = "SecureString"
  value       = random_password.grafana_admin.result
}

# El token de la cuenta de servicio de Grafana lo crea Ansible y lo guarda en
# /asistencia/plataforma/grafana-token; la API de la plataforma lo lee de ahí (RF-29).

# ---------- Playbook de Ansible en S3 ----------

data "archive_file" "ansible" {
  type        = "zip"
  source_dir  = "${path.module}/../../ansible"
  output_path = "${path.module}/.ansible.zip"
}

resource "aws_s3_object" "ansible" {
  bucket      = local.bucket
  key         = "artefactos/ansible/plataforma.zip"
  source      = data.archive_file.ansible.output_path
  source_hash = data.archive_file.ansible.output_base64sha256
}

resource "aws_s3_object" "vars" {
  bucket       = local.bucket
  key          = "artefactos/ansible/vars.json"
  content      = jsonencode(local.vars_ansible)
  content_type = "application/json"
}

# ---------- IAM ----------

resource "aws_iam_role" "plataforma" {
  name = "${local.prefijo}-rol"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "plataforma" {
  name = "monitoreo"
  role = aws_iam_role.plataforma.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DescubrirTenants" # ec2_sd_configs de Prometheus
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances", "ec2:DescribeAvailabilityZones"]
        Resource = "*"
      },
      {
        Sid      = "LeerPlaybook"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "arn:aws:s3:::${local.bucket}/artefactos/ansible/*"
      },
      {
        Sid      = "SecretosPlataforma"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${local.ssm_prefijo}/*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.plataforma.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "plataforma" {
  name = "${local.prefijo}-perfil"
  role = aws_iam_role.plataforma.name
}

# ---------- EC2 ----------

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
}

resource "aws_instance" "plataforma" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = sort(data.aws_subnets.publicas.ids)[0]
  vpc_security_group_ids = [data.aws_security_group.plataforma.id]
  iam_instance_profile   = aws_iam_instance_profile.plataforma.name

  metadata_options {
    http_tokens = "required" # IMDSv2
  }

  root_block_device {
    volume_size = var.root_volume_gb # incluye la base de Prometheus
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    Region  = var.region
    Bucket  = local.bucket
    Archivo = aws_s3_object.ansible.key
    Vars    = aws_s3_object.vars.key
  })

  tags = { Name = local.prefijo }

  lifecycle {
    ignore_changes = [ami] # una AMI nueva de Amazon no recrea la plataforma
  }

  depends_on = [aws_iam_role_policy.plataforma, aws_ssm_parameter.grafana_admin]
}

# IP fija: la URL de Grafana no cambia si la instancia se detiene
resource "aws_eip" "plataforma" {
  instance = aws_instance.plataforma.id
  domain   = "vpc"
  tags     = { Name = local.prefijo }
}

# Cambios posteriores del playbook o de las variables: la asociación cambia con el hash
# del paquete y SSM vuelve a ejecutar el playbook en la instancia, sin recrearla ni abrir SSH.
resource "aws_ssm_association" "ansible" {
  name             = "AWS-RunShellScript"
  association_name = "${local.prefijo}-ansible"
  parameters = {
    commands = "/usr/local/bin/aplicar-ansible.sh # ${data.archive_file.ansible.output_md5} ${md5(aws_s3_object.vars.content)}"
  }
  targets {
    key    = "InstanceIds"
    values = [aws_instance.plataforma.id]
  }
}
