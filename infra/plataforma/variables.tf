variable "aws_account_id" {
  type    = string
  default = "207381449073"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  description = "Prometheus y Grafana necesitan ~1 GB de RAM; t3.small tiene 2 GB"
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  type    = number
  default = 20
}

variable "retencion_metricas_dias" {
  type    = number
  default = 15
}

variable "cidrs_admin" {
  description = "IPs (CIDR) que pueden abrir el portal y Grafana, p. ej. [\"200.1.2.3/32\"]. Va en terraform.tfvars, que no se sube a git."
  type        = list(string)
  validation {
    condition     = alltrue([for c in var.cidrs_admin : can(cidrnetmask(c)) && c != "0.0.0.0/0"])
    error_message = "Cada valor debe ser un CIDR válido y no puede ser 0.0.0.0/0."
  }
}

variable "plataforma_ref" {
  description = "Rama o tag de plataforma-tenants que se despliega en la EC2"
  type        = string
  default     = "main"
}

variable "infra_ref" {
  description = "Rama o tag de asistencia-infra que usa el worker para los tenants"
  type        = string
  default     = "main"
}

variable "app_version" {
  description = "Rama o tag de asistencia-app que se instala en los tenants nuevos"
  type        = string
  default     = "main"
}
