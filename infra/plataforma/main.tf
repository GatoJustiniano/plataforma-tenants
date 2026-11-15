# EC2 de la plataforma (plano de control): portal, API y worker (que crea los tenants con el
# rol IAM de la instancia) y el monitoreo (Prometheus, blackbox_exporter y Grafana). Todo lo
# instala Ansible.
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
    plataforma_ref    = var.plataforma_ref
    infra_ref         = var.infra_ref
    app_version       = var.app_version
  }
  estado_tenants = "arn:aws:s3:::${local.bucket}/tenants/*"
  limite_tenant  = "asistencia-limite-tenant" # permissions boundary de los roles de los tenants
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

# El portal (API y panel, puerto 80) también; además pide la clave de administrador
resource "aws_vpc_security_group_ingress_rule" "portal" {
  for_each          = toset(var.cidrs_admin)
  security_group_id = data.aws_security_group.plataforma.id
  description       = "Portal de la plataforma desde administracion"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.value
}

# ---------- Secretos ----------

# Clave de administrador del portal (cabecera X-Admin-Key). Ansible la pasa a la API.
resource "random_password" "admin_key" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "admin_key" {
  name        = "${local.ssm_prefijo}/admin-key"
  description = "Clave de administrador del portal de la plataforma"
  type        = "SecureString"
  value       = random_password.admin_key.result
}

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

# ---------- IAM del worker: crea y elimina tenants ----------
# Solo lo que usa el módulo tenant de asistencia-infra. Lo destructivo exige el tag
# Componente=tenant: el worker no puede tocar la plataforma ni otros recursos de la cuenta.

resource "aws_iam_role_policy" "worker" {
  name = "worker-tenants"
  role = aws_iam_role.plataforma.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EstadoTerraform"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = local.estado_tenants
      },
      {
        Sid       = "ListarEstado"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = "arn:aws:s3:::${local.bucket}"
        Condition = { StringLike = { "s3:prefix" = ["tenants/*"] } }
      },
      {
        Sid      = "LeerEc2"
        Effect   = "Allow"
        Action   = ["ec2:Describe*", "ec2:GetEbsEncryptionByDefault"]
        Resource = "*"
      },
      {
        Sid    = "CrearRecursosTenant"
        Effect = "Allow"
        Action = ["ec2:RunInstances", "ec2:CreateVolume", "ec2:CreateSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules"]
        Resource = "*"
      },
      {
        Sid       = "EtiquetarAlCrear"
        Effect    = "Allow"
        Action    = "ec2:CreateTags"
        Resource  = "*"
        Condition = { StringEquals = { "ec2:CreateAction" = ["RunInstances", "CreateVolume", "CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "CreateSnapshot"] } }
      },
      {
        Sid    = "ModificarSoloTenants"
        Effect = "Allow"
        Action = ["ec2:CreateTags", "ec2:DeleteTags", "ec2:TerminateInstances", "ec2:StopInstances",
          "ec2:StartInstances", "ec2:ModifyInstanceAttribute", "ec2:ModifyInstanceMetadataOptions",
          "ec2:ModifyInstanceCreditSpecification", "ec2:AttachVolume", "ec2:DetachVolume",
        "ec2:DeleteVolume", "ec2:ModifyVolume", "ec2:DeleteSecurityGroup", "ec2:DeleteSnapshot"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:ResourceTag/Componente" = "tenant" } }
      },
      {
        # Motor CloudFormation (RF-08): solo los stacks de tenants (asistencia-<id>) y los change sets
        # que crea "aws cloudformation deploy". Los recursos del stack se crean con estos mismos permisos.
        Sid    = "StacksTenants"
        Effect = "Allow"
        Action = ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:ListStackResources",
          "cloudformation:CreateChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DescribeChangeSet",
        "cloudformation:DeleteChangeSet", "cloudformation:GetTemplate", "cloudformation:TagResource"]
        Resource = ["arn:aws:cloudformation:${var.region}:${var.aws_account_id}:stack/asistencia-*/*",
        "arn:aws:cloudformation:${var.region}:${var.aws_account_id}:changeSet/awscli-cloudformation-package-deploy-*/*"]
      },
      {
        Sid      = "ValidarPlantillas"
        Effect   = "Allow"
        Action   = ["cloudformation:ValidateTemplate", "cloudformation:GetTemplateSummary"]
        Resource = "*"
      },
      {
        # Respaldo a pedido (RF-19): solo de volúmenes de tenants...
        Sid       = "RespaldarVolumenTenant"
        Effect    = "Allow"
        Action    = "ec2:CreateSnapshot"
        Resource  = "arn:aws:ec2:${var.region}:${var.aws_account_id}:volume/*"
        Condition = { StringEquals = { "aws:ResourceTag/Componente" = "tenant" } }
      },
      {
        # ...y el snapshot nace con el tag Componente=tenant (si no, no podría borrarlo después)
        Sid       = "CrearSnapshotTenant"
        Effect    = "Allow"
        Action    = "ec2:CreateSnapshot"
        Resource  = "arn:aws:ec2:${var.region}::snapshot/*"
        Condition = { StringEquals = { "aws:RequestTag/Componente" = "tenant" } }
      },
      {
        Sid    = "SecretosTenants"
        Effect = "Allow"
        Action = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:GetParameters",
        "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"]
        Resource = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter/asistencia/*"
      },
      {
        Sid      = "LeerMetadatosParametros"
        Effect   = "Allow"
        Action   = ["ssm:DescribeParameters", "ssm:ListTagsForResource"] # solo lectura; ListTagsForResource no se evalúa por ARN del parámetro
        Resource = "*"
      },
      {
        # Los roles de los tenants solo se crean y cambian con el límite asistencia-limite-tenant
        Sid    = "RolesTenantsConLimite"
        Effect = "Allow"
        Action = ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource  = "arn:aws:iam::${var.aws_account_id}:role/asistencia-*"
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.limite_tenant.arn } }
      },
      {
        Sid    = "GestionarRolesTenants"
        Effect = "Allow"
        Action = ["iam:GetRole", "iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListRoleTags",
        "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole"]
        Resource = "arn:aws:iam::${var.aws_account_id}:role/asistencia-*"
      },
      {
        Sid    = "PerfilesTenants"
        Effect = "Allow"
        Action = ["iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
          "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile",
        "iam:UntagInstanceProfile"]
        Resource = "arn:aws:iam::${var.aws_account_id}:instance-profile/asistencia-*"
      },
      {
        Sid       = "PasarRolATenant"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = "arn:aws:iam::${var.aws_account_id}:role/asistencia-*"
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
      {
        # Nada de lo anterior aplica a la propia plataforma: ni a su rol ni a su perfil
        Sid    = "ProtegerPlataforma"
        Effect = "Deny"
        Action = ["iam:*"]
        Resource = ["arn:aws:iam::${var.aws_account_id}:role/${local.prefijo}-*",
        "arn:aws:iam::${var.aws_account_id}:instance-profile/${local.prefijo}-*"]
      },
      {
        Sid      = "ProtegerSecretosPlataforma"
        Effect   = "Deny"
        Action   = ["ssm:DeleteParameter", "ssm:DeleteParameters"]
        Resource = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${local.ssm_prefijo}/*"
      },
      {
        Sid      = "SinQuitarLimite"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary", "iam:CreatePolicyVersion", "iam:DeletePolicy"]
        Resource = "*"
      },
    ]
  })
}

# Techo de permisos de los roles de los tenants: aunque alguien escribiera otra política en
# un rol de tenant, este no podría hacer más que registrarse en SSM y leer los secretos de su tenant.
resource "aws_iam_policy" "limite_tenant" {
  name        = local.limite_tenant
  description = "Permissions boundary de los roles de los tenants de asistencia"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AgenteSsm" # lo que usa AmazonSSMManagedInstanceCore
        Effect = "Allow"
        Action = ["ssm:UpdateInstanceInformation", "ssm:ListAssociations", "ssm:ListInstanceAssociations",
          "ssm:DescribeAssociation", "ssm:GetDocument", "ssm:DescribeDocument", "ssm:UpdateAssociationStatus",
          "ssm:UpdateInstanceAssociationStatus", "ssm:PutInventory", "ssm:PutComplianceItems",
          "ssm:PutConfigurePackageResult", "ssm:GetDeployablePatchSnapshotForInstance", "ssm:GetManifest",
        "ssmmessages:*", "ec2messages:*", "s3:GetEncryptionConfiguration"]
        Resource = "*"
      },
      {
        # Solo los parámetros de SU tenant (tag Tenant del rol). Hace falta aquí y no solo en la
        # política del rol: AmazonSSMManagedInstanceCore concede ssm:GetParameter sobre "*".
        Sid      = "SecretosDelPropioTenant"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter/asistencia/$${aws:PrincipalTag/Tenant}/*"
      },
      {
        Sid       = "DescifrarSecretos"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } }
      },
      {
        Sid      = "NuncaSecretosPlataforma"
        Effect   = "Deny"
        Action   = "ssm:*"
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

# ---------- Respaldos programados (RF-19) ----------
# Una política de AWS Data Lifecycle Manager por plan: respalda los volúmenes con el tag
# Respaldo=<plan> (solo el volumen de datos de cada tenant) con la frecuencia y retención
# del catálogo. Los respaldos a pedido y la restauración los hace el worker.

locals {
  # semanal: domingos; diario: todos los días. 06:00 UTC = 02:00 en Bolivia.
  respaldos = { for p in local.catalogo.planes : p.id => {
    frecuencia = p.operacion.respaldo
    dias       = p.operacion.retencion_respaldos_dias
  } }
}

# El nombre empieza por asistencia-plataforma-: el Deny del worker lo protege
resource "aws_iam_role" "dlm" {
  name = "${local.prefijo}-dlm"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "respaldos" {
  for_each           = local.respaldos
  description        = "Respaldos del plan ${each.key} - ${each.value.frecuencia} - ${each.value.dias} dias" # DLM: solo letras, numeros, espacios y guiones
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Respaldo = each.key }

    schedule {
      name = "${each.value.frecuencia}-${each.value.dias}d"

      create_rule {
        # Diario: cada 24 h a las 06:00 UTC. Semanal: domingos a las 06:00 UTC.
        interval        = each.value.frecuencia == "diario" ? 24 : null
        interval_unit   = each.value.frecuencia == "diario" ? "HOURS" : null
        times           = each.value.frecuencia == "diario" ? ["06:00"] : null
        cron_expression = each.value.frecuencia == "semanal" ? "cron(0 6 ? * SUN *)" : null
      }

      retain_rule {
        interval      = each.value.dias
        interval_unit = "DAYS"
      }

      # Copia los tags del volumen (Tenant, Plan, Componente...): así la plataforma
      # encuentra los snapshots de cada tenant y el worker puede restaurarlos.
      copy_tags   = true
      tags_to_add = { Origen = "programado" }
    }
  }

  lifecycle {
    precondition {
      condition     = contains(["diario", "semanal"], each.value.frecuencia)
      error_message = "operacion.respaldo del plan ${each.key} debe ser diario o semanal."
    }
  }

  depends_on = [aws_iam_role_policy_attachment.dlm]
}
