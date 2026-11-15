// Motor CloudFormation (implementación reducida, RF-08): la plantilla asistencia-infra/cloudformation/tenant.yaml.
// Tiene la misma interfaz que el motor Terraform; el estado lo guarda AWS (un stack por tenant).
//
// Lo que CloudFormation no hace y resuelve este motor:
//  - El secreto del tenant (SecureString): lo crea aquí, antes del stack. AWS::SSM::Parameter no admite SecureString.
//  - Suspender y reanudar: stop/start-instances. No hay recurso de CloudFormation para el estado de una instancia.
//  - Red, AMI y user data: se resuelven aquí y llegan como parámetros.
//  - Reintento tras un fallo al crear: el stack queda en ROLLBACK_COMPLETE (ya sin recursos); se borra y se vuelve a crear.
// Restaurar un respaldo solo está disponible con Terraform/OpenTofu.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { aws: awsSilencioso } = require('../../comun/respaldos');

const REGION = process.env.AWS_REGION || 'us-east-1';
const APP_REPO_URL = process.env.APP_REPO_URL || 'https://github.com/GatoJustiniano/asistencia-app.git';
const PLANTILLA = 'tenant.yaml';

const TIPOS = { // para mostrar la previsualización de la eliminación como en Terraform
  'AWS::EC2::Volume': 'aws_ebs_volume', 'AWS::EC2::Instance': 'aws_instance', 'AWS::EC2::SecurityGroup': 'aws_security_group',
  'AWS::IAM::Role': 'aws_iam_role', 'AWS::IAM::InstanceProfile': 'aws_iam_instance_profile', 'AWS::EC2::VolumeAttachment': 'aws_volume_attachment',
};

function crearMotorCfn() {
  let tenantId = null;
  const pila = () => `asistencia-${tenantId}`;
  const secreto = () => `/asistencia/${tenantId}/admin-key`;

  // AWS CLI con salida JSON. mostrar=false para no poner en el log comandos con datos sensibles.
  // mostrar=false: consultas internas, sin escribir en el log (ni el comando ni los errores esperados)
  const aws = async (reg, args, { mostrar = true } = {}) => {
    if (!mostrar) return awsSilencioso(args);
    const out = await reg.ejecutar('aws', [...args, '--region', REGION, '--output', 'json'], { capturar: true });
    try { return out.trim() ? JSON.parse(out) : {}; } catch { return {}; }
  };
  const awsTexto = (reg, args, opts) => reg.ejecutar('aws', [...args, '--region', REGION], { capturar: true, ...opts });

  async function estadoPila(reg) {
    try {
      const r = await aws(reg, ['cloudformation', 'describe-stacks', '--stack-name', pila()], { mostrar: false });
      return r.Stacks?.[0] || null;
    } catch (e) {
      if (/does not exist/.test(e.salida || '')) return null;
      throw e;
    }
  }

  // Motivos de los recursos que fallaron: así errores.js puede traducirlos (permisos, plan gratuito...)
  async function motivosFallo(reg) {
    try {
      const r = await aws(reg, ['cloudformation', 'describe-stack-events', '--stack-name', pila(), '--max-items', '40'], { mostrar: false });
      return (r.StackEvents || []).filter((e) => /FAILED/.test(e.ResourceStatus) && e.ResourceStatusReason)
        .slice(0, 5).map((e) => `${e.LogicalResourceId}: ${e.ResourceStatusReason}`);
    } catch { return []; }
  }

  async function instancia(reg) {
    const p = await estadoPila(reg);
    const id = p?.Outputs?.find((o) => o.OutputKey === 'InstanceId')?.OutputValue;
    if (!id) return null;
    const r = await aws(reg, ['ec2', 'describe-instances', '--instance-ids', id], { mostrar: false });
    return r.Reservations?.[0]?.Instances?.[0] || null;
  }

  async function detener(reg) {
    const i = await instancia(reg);
    if (!i || ['stopped', 'terminated'].includes(i.State.Name)) return;
    reg.linea(`Deteniendo ${i.InstanceId} (antes de desconectar el volumen de datos)`);
    await aws(reg, ['ec2', 'stop-instances', '--instance-ids', i.InstanceId]);
    await awsTexto(reg, ['ec2', 'wait', 'instance-stopped', '--instance-ids', i.InstanceId]);
  }

  // Secreto del tenant en SSM (SecureString). Se crea una sola vez; reintentar no lo cambia.
  async function asegurarSecreto(reg, v, dir) {
    try {
      await aws(reg, ['ssm', 'get-parameter', '--name', secreto()], { mostrar: false });
      reg.linea(`Secreto ${secreto()}: ya existe`);
      return;
    } catch (e) {
      if (!/ParameterNotFound/.test(e.salida || '')) throw e;
    }
    const valor = Array.from(crypto.randomBytes(20), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
    const archivo = path.join(dir, '.secreto'); // por archivo: el valor no queda en la línea de comandos ni en el log
    fs.writeFileSync(archivo, valor, { mode: 0o600 });
    try {
      await aws(reg, ['ssm', 'put-parameter', '--name', secreto(), '--type', 'SecureString', '--value', `file://${archivo}`,
        '--description', `Clave del panel docente del tenant ${tenantId}`,
        '--tags', ...Object.entries(etiquetas(v)).map(([k, val]) => `Key=${k},Value=${val}`)], { mostrar: false });
    } finally { fs.rmSync(archivo, { force: true }); }
    reg.linea(`Secreto ${secreto()}: creado (SecureString)`);
  }

  const etiquetas = (v) => ({ Proyecto: 'asistencia', Componente: 'tenant', Tenant: v.tenant_id, Entorno: v.entorno, Plan: v.plan, Herramienta: 'cloudformation' });

  // Red compartida y AMI: lo mismo que busca el módulo de Terraform (tags Rol=red-tenants, Tipo=publica...)
  async function resolver(reg, v) {
    const vpc = (await aws(reg, ['ec2', 'describe-vpcs', '--filters', 'Name=tag:Rol,Values=red-tenants'], { mostrar: false })).Vpcs?.[0]?.VpcId;
    if (!vpc) throw new Error('no matching EC2 VPC found (falta infra/red)');
    const subredes = ((await aws(reg, ['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=tag:Tipo,Values=publica'], { mostrar: false })).Subnets || [])
      .sort((a, b) => a.SubnetId.localeCompare(b.SubnetId));
    // Misma subred que elegiría Terraform: md5 del id, estable para cada tenant
    const subred = subredes[parseInt(crypto.createHash('md5').update(v.tenant_id).digest('hex').slice(0, 4), 16) % subredes.length];
    const sg = (await aws(reg, ['ec2', 'describe-security-groups', '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=tag:Rol,Values=sg-plataforma'], { mostrar: false })).SecurityGroups?.[0]?.GroupId;
    if (!sg) throw new Error('no matching EC2 Security Group found (falta infra/red)');
    const masNueva = (imgs) => (imgs || []).sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))[0]?.ImageId;
    let ami = masNueva((await aws(reg, ['ec2', 'describe-images', '--owners', 'self', '--filters', 'Name=tag:Rol,Values=ami-tenant', 'Name=state,Values=available'], { mostrar: false })).Images);
    if (!ami) ami = masNueva((await aws(reg, ['ec2', 'describe-images', '--owners', 'amazon', '--filters', 'Name=name,Values=al2023-ami-2023.*-x86_64', 'Name=state,Values=available'], { mostrar: false })).Images);
    reg.linea(`Red: ${vpc}, subred ${subred.SubnetId} (${subred.AvailabilityZone}), SG plataforma ${sg}; AMI ${ami}`);
    return { vpc, subred: subred.SubnetId, zona: subred.AvailabilityZone, sg, ami };
  }

  // Renderiza cloud-init.yaml (plantilla de Terraform: ${Var} se reemplaza y $${...} queda como ${...})
  function userData(dir, v) {
    const valores = {
      TenantId: v.tenant_id, Entorno: v.entorno, Plan: v.plan, Region: REGION, SsmPrefijo: `/asistencia/${v.tenant_id}`,
      VolumenDatos: '', // CloudFormation no lo conoce aún: cloud-init usa /dev/sdf
      AppRepoUrl: APP_REPO_URL, AppVersion: v.app_version, DemoData: 'true',
      MaxEstudiantes: v.limites.estudiantes, MaxDocentes: v.limites.docentes, MaxCursos: v.limites.cursos,
      InstitucionB64: Buffer.from(v.nombre || '', 'utf8').toString('base64'),
    };
    const texto = fs.readFileSync(path.join(dir, '..', 'cloud-init', 'cloud-init.yaml'), 'utf8').replace(/\r\n/g, '\n')
      .replace(/\$\$\{/g, '\u0000')
      .replace(/\$\{(\w+)\}/g, (_, k) => { if (!(k in valores)) throw new Error(`cloud-init usa \${${k}}, que el motor CloudFormation no conoce`); return String(valores[k]); })
      .replace(/\u0000/g, '${');
    const b64 = zlib.gzipSync(Buffer.from(texto, 'utf8'), { level: 9 }).toString('base64'); // cloud-init acepta gzip
    if (b64.length > 4096) throw new Error(`El user data comprimido ocupa ${b64.length} bytes y un parámetro admite 4096`);
    return b64;
  }

  return {
    nombre: 'cloudformation',
    carpeta: 'cloudformation',

    async init(reg, dir, id) {
      tenantId = id;
      await aws(reg, ['cloudformation', 'validate-template', '--template-body', `file://${path.join(dir, PLANTILLA)}`]);
      reg.linea(`Plantilla válida. Stack: ${pila()} (el estado lo guarda CloudFormation)`);
    },

    async version(reg) {
      const v = (await reg.ejecutar('aws', ['--version'], { capturar: true, mostrar: false })).trim();
      return { nombre: 'cloudformation', version: v.split(' ')[0].replace('aws-cli/', 'aws-cli '), providers: {} };
    },

    async apply(reg, dir, varFile) {
      const v = JSON.parse(fs.readFileSync(path.join(dir, varFile), 'utf8'));
      let p = await estadoPila(reg);

      if (v.suspendido) {
        if (!p) throw new Error(`El stack ${pila()} no existe`);
        await detener(reg);
        return;
      }

      // RF-12 con CloudFormation: si la creación falló, el stack queda en ROLLBACK_COMPLETE, sin recursos,
      // y no admite actualizaciones. Se borra y se vuelve a crear: no se duplica nada.
      if (p && ['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'DELETE_FAILED'].includes(p.StackStatus)) {
        reg.linea(`El stack quedó en ${p.StackStatus} por un intento anterior: se borra y se vuelve a crear`);
        await aws(reg, ['cloudformation', 'delete-stack', '--stack-name', pila()]);
        await awsTexto(reg, ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', pila()]);
        p = null;
      }

      await asegurarSecreto(reg, v, dir);
      const r = await resolver(reg, v);
      const parametros = {
        TenantId: v.tenant_id, Entorno: v.entorno, Plan: v.plan, InstanceType: v.instance_type,
        RootVolumeGb: v.root_volume_gb, DataVolumeGb: v.data_volume_gb,
        VpcId: r.vpc, SubnetId: r.subred, AvailabilityZone: r.zona, SgPlataforma: r.sg, UserData: userData(dir, v),
      };
      // La AMI solo se elige al crear: una AMI nueva no debe recrear un tenant existente (como ignore_changes en Terraform)
      if (!p) parametros.AmiId = r.ami;

      reg.linea(`$ aws cloudformation deploy --stack-name ${pila()} --template-file ${PLANTILLA} ${p ? '(actualizar)' : '(crear)'}`);
      try {
        await reg.ejecutar('aws', ['cloudformation', 'deploy', '--region', REGION, '--stack-name', pila(),
          '--template-file', path.join(dir, PLANTILLA), '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset',
          '--parameter-overrides', ...Object.entries(parametros).map(([k, val]) => `${k}=${val}`),
          '--tags', ...Object.entries(etiquetas(v)).map(([k, val]) => `${k}=${val}`)], { mostrar: false });
      } catch (e) {
        const motivos = await motivosFallo(reg);
        motivos.forEach((m) => reg.linea(`  ✗ ${m}`));
        throw Object.assign(new Error(`CloudFormation no pudo aplicar el stack ${pila()}`), { salida: `${e.salida || ''}\n${motivos.join('\n')}` });
      }

      // Reanudar: el stack no cambia, pero la instancia puede estar detenida
      const i = await instancia(reg);
      if (i && i.State.Name === 'stopped') {
        reg.linea(`Arrancando ${i.InstanceId}`);
        await aws(reg, ['ec2', 'start-instances', '--instance-ids', i.InstanceId]);
        await awsTexto(reg, ['ec2', 'wait', 'instance-running', '--instance-ids', i.InstanceId]);
      }
    },

    async outputs(reg) {
      const p = await estadoPila(reg);
      const o = Object.fromEntries((p?.Outputs || []).map((x) => [x.OutputKey, x.OutputValue]));
      const i = await instancia(reg); // la IP pública cambia al detener y arrancar
      const ip = i?.State?.Name === 'running' ? i.PublicIpAddress : null;
      return {
        instance_id: o.InstanceId || null, data_volume_id: o.DataVolumeId || null, security_group_id: o.SecurityGroupId || null,
        ami_id: o.AmiId || null, ssm_prefijo: o.SsmPrefijo || null, public_ip: ip, url_app: ip ? `http://${ip}` : null,
        estado_instancia: i?.State?.Name || null, stack: pila(),
      };
    },

    // RF-18: lo que se borraría. CloudFormation no tiene "plan -destroy": se listan los recursos del stack.
    async planDestroy(reg) {
      const p = await estadoPila(reg);
      const recursos = [];
      if (p) {
        const r = await aws(reg, ['cloudformation', 'list-stack-resources', '--stack-name', pila()]);
        for (const x of r.StackResourceSummaries || []) {
          if (x.ResourceStatus === 'DELETE_COMPLETE') continue;
          recursos.push({ direccion: `${pila()}/${x.LogicalResourceId}`, tipo: TIPOS[x.ResourceType] || x.ResourceType, nombre: x.PhysicalResourceId || null });
        }
      }
      recursos.push({ direccion: 'ssm (fuera del stack)', tipo: 'aws_ssm_parameter', nombre: secreto() });
      return recursos;
    },

    async destroy(reg) {
      const p = await estadoPila(reg);
      if (p) {
        await detener(reg); // como stop_instance_before_detaching en Terraform: no corromper SQLite
        await aws(reg, ['cloudformation', 'delete-stack', '--stack-name', pila()]);
        try {
          await awsTexto(reg, ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', pila()]);
        } catch (e) {
          const motivos = await motivosFallo(reg);
          throw Object.assign(new Error(`CloudFormation no pudo borrar el stack ${pila()}`), { salida: `${e.salida || ''}\n${motivos.join('\n')}` });
        }
      }
      try {
        await aws(reg, ['ssm', 'delete-parameter', '--name', secreto()]);
      } catch (e) { if (!/ParameterNotFound/.test(e.salida || '')) throw e; }
      reg.linea(`Stack ${pila()} y secreto eliminados`);
    },
  };
}

module.exports = { crearMotorCfn };
