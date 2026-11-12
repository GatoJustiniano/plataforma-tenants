output "grafana_url" {
  value = "http://${aws_eip.plataforma.public_ip}:3000"
}

output "dashboard_url" {
  value = "http://${aws_eip.plataforma.public_ip}:3000/d/asistencia-tenants"
}

output "instance_id" {
  value = aws_instance.plataforma.id
}

output "public_ip" {
  value = aws_eip.plataforma.public_ip
}

output "ssm_grafana_admin" {
  description = "Clave de admin de Grafana (SecureString)"
  value       = aws_ssm_parameter.grafana_admin.name
}

output "ssm_grafana_token" {
  description = "Token de solo lectura que usa la API de la plataforma"
  value       = "${local.ssm_prefijo}/grafana-token"
}
