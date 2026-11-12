# Red compartida por todos los tenants (una sola VPC: AWS limita a 5 VPC por región).
# El aislamiento entre tenants lo dan los Security Groups, no la red.
# Los tenants encuentran estos recursos por tags (Rol = red-tenants / sg-plataforma).

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket       = "asistencia-iac-estado-207381449073"
    key          = "plataforma/red.tfstate"
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

variable "aws_account_id" {
  type    = string
  default = "207381449073"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

# Zonas que ofrecen todos los tipos de instancia del catálogo de planes
data "aws_ec2_instance_type_offerings" "zonas" {
  location_type = "availability-zone"
  filter {
    name   = "instance-type"
    values = ["t3.micro", "t3.small", "t3.medium"]
  }
}

locals {
  prefijo = "asistencia-plataforma"
  # Dos zonas que tengan los tres tipos de instancia
  zonas = slice(sort([
    for z in distinct(data.aws_ec2_instance_type_offerings.zonas.locations) : z
    if length([for l in data.aws_ec2_instance_type_offerings.zonas.locations : l if l == z]) == 3
  ]), 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "${local.prefijo}-vpc", Rol = "red-tenants" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${local.prefijo}-igw" }
}

resource "aws_subnet" "publica" {
  count                   = length(local.zonas)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 1)
  availability_zone       = local.zonas[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.prefijo}-publica-${count.index + 1}", Tipo = "publica" }
}

resource "aws_route_table" "publica" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${local.prefijo}-rt-publica" }
}

resource "aws_route_table_association" "publica" {
  count          = length(aws_subnet.publica)
  subnet_id      = aws_subnet.publica[count.index].id
  route_table_id = aws_route_table.publica.id
}

# SG de la EC2 de la plataforma. Los SG de los tenants solo aceptan
# métricas (Prometheus) y SSH (Ansible) desde este grupo.
resource "aws_security_group" "plataforma" {
  name        = "${local.prefijo}-sg"
  description = "EC2 de la plataforma: portal, worker, Prometheus y Grafana"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.prefijo}-sg", Rol = "sg-plataforma" }
}

resource "aws_vpc_security_group_egress_rule" "plataforma" {
  security_group_id = aws_security_group.plataforma.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "subnet_ids" {
  value = aws_subnet.publica[*].id
}

output "zonas" {
  value = local.zonas
}

output "sg_plataforma_id" {
  value = aws_security_group.plataforma.id
}
