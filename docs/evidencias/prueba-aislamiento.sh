#!/bin/bash
# Pruebas de aislamiento que se ejecutan DENTRO de la EC2 de un tenant (con Session Manager):
#
#   aws ssm send-command --instance-ids <instance_id> --document-name AWS-RunShellScript \
#     --parameters "$(python -c "import json;print(json.dumps({'commands':[open('docs/evidencias/prueba-aislamiento.sh').read()]}))")"
#
# Nunca imprime el valor de un secreto: solo si se pudo leer y su longitud.
# Ajusta OTROS (otros tenants), OTRO_IP (IP privada de otro tenant) y PLATAFORMA_IP.
OTROS="${OTROS:-el-pepe la-salle}"
OTRO_IP="${OTRO_IP:-10.20.1.187}"
PLATAFORMA_IP="${PLATAFORMA_IP:-10.20.2.93}"
BUCKET="${BUCKET:-asistencia-iac-estado-207381449073}"

probar() {
  r=$(aws ssm get-parameter --region us-east-1 --with-decryption --name "$1" --query Parameter.Value --output text 2>&1)
  if [ $? -eq 0 ]; then echo "PERMITIDO $1 (valor de ${#r} caracteres, no se muestra)"
  else echo "DENEGADO  $1 -> $(echo "$r" | grep -o 'AccessDeniedException\|ParameterNotFound' | head -1)"; fi
}

TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
ROL=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/)
YO=${ROL#asistencia-}; YO=${YO%-rol}

echo "== Secretos (rol $ROL)"
probar "/asistencia/$YO/admin-key"
for OTRO in $OTROS; do [ "$OTRO" != "$YO" ] && probar "/asistencia/$OTRO/admin-key"; done
probar /asistencia/plataforma/admin-key
probar /asistencia/plataforma/grafana-admin

echo "== Otras APIs de AWS"
aws ec2 describe-instances --region us-east-1 --max-items 1 >/dev/null 2>&1 && echo "PERMITIDO ec2:DescribeInstances" || echo "DENEGADO  ec2:DescribeInstances"
aws s3 ls "s3://$BUCKET/tenants/" >/dev/null 2>&1 && echo "PERMITIDO leer estados en S3" || echo "DENEGADO  leer estados en S3"
aws iam list-roles --max-items 1 >/dev/null 2>&1 && echo "PERMITIDO iam:ListRoles" || echo "DENEGADO  iam:ListRoles"

echo "== Red hacia otro tenant ($OTRO_IP) y la plataforma ($PLATAFORMA_IP)"
for d in $OTRO_IP:80 $OTRO_IP:9100 $OTRO_IP:9101 $OTRO_IP:22 $PLATAFORMA_IP:3000 $PLATAFORMA_IP:9090 $PLATAFORMA_IP:22; do
  timeout 4 bash -c "</dev/tcp/${d%:*}/${d#*:}" 2>/dev/null && echo "ABIERTO  $d" || echo "CERRADO  $d"
done

echo "== Datos"
findmnt -n -o SOURCE,TARGET,FSTYPE /var/lib/asistencia
ls -l /var/lib/asistencia
