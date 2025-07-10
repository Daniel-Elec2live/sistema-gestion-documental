const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const multiparty = require('multiparty');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('dotenv').config();

// Función helper para procesar la clave privada
function processPrivateKey(key) {
  // Eliminar posibles espacios extras y asegurar formato correcto
  let processedKey = key.trim();
  
  // Si la clave no tiene los headers, agregarlos
  if (!processedKey.includes('BEGIN')) {
    processedKey = `-----BEGIN PRIVATE KEY-----\n${processedKey}\n-----END PRIVATE KEY-----`;
  }
  
  // Reemplazar los \n literales por saltos de línea reales
  processedKey = processedKey.replace(/\\n/g, '\n');
  
  // Asegurar que haya saltos de línea después de los headers
  processedKey = processedKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/-----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----');
  
  // Eliminar saltos de línea duplicados
  processedKey = processedKey.replace(/\n\n+/g, '\n');
  
  return processedKey;
}

// Función helper para obtener información del archivo/carpeta
async function getFileInfo(drive, fileId) {
  try {
    const response = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, parents, driveId',
      supportsAllDrives: true
    });
    return response.data;
  } catch (error) {
    console.error('Error obteniendo información del archivo:', error);
    return null;
  }
}

// Función para dar permisos de acceso al trabajador
async function grantWorkerAccess(drive, carpetaId, workerEmail, accessLevel = 'reader') {
  try {
    console.log(`🔐 Dando acceso ${accessLevel} a ${workerEmail} para carpeta ${carpetaId}...`);
    
    // Crear permiso para el trabajador
    const permission = await drive.permissions.create({
      fileId: carpetaId,
      resource: {
        role: accessLevel, // 'reader', 'writer', 'commenter'
        type: 'user',
        emailAddress: workerEmail
      },
      supportsAllDrives: true,
      sendNotificationEmail: true, // Enviar email de notificación
      emailMessage: 'Te hemos dado acceso a tu carpeta personal de documentos laborales.'
    });

    console.log('✅ Permiso otorgado:', permission.data.id);
    return permission.data;
    
  } catch (error) {
    console.error('❌ Error otorgando permisos:', error);
    
    // Si el email no es válido o no existe, continuar sin fallar
    if (error.code === 400) {
      console.warn('⚠️ Email inválido o usuario no encontrado, continuando...');
      return null;
    }
    
    throw error;
  }
}

// Función para dar acceso a todas las subcarpetas
async function grantWorkerAccessToAllFolders(drive, carpetaId, subcarpetasIds, workerEmail) {
  const permissions = [];
  
  try {
    // Dar acceso a la carpeta principal
    const mainFolderPermission = await grantWorkerAccess(drive, carpetaId, workerEmail, 'reader');
    if (mainFolderPermission) {
      permissions.push({ folderId: carpetaId, permissionId: mainFolderPermission.id, type: 'main' });
    }

    // Dar acceso a todas las subcarpetas en paralelo
    const subfolderPromises = subcarpetasIds.map(async (subcarpeta) => {
      if (subcarpeta.id) {
        try {
          const permission = await grantWorkerAccess(drive, subcarpeta.id, workerEmail, 'reader');
          if (permission) {
            return { folderId: subcarpeta.id, permissionId: permission.id, type: 'subfolder', name: subcarpeta.nombre };
          }
        } catch (error) {
          console.error(`Error dando acceso a subcarpeta ${subcarpeta.nombre}:`, error);
        }
      }
      return null;
    });

    const subfolderPermissions = await Promise.all(subfolderPromises);
    permissions.push(...subfolderPermissions.filter(p => p !== null));

    console.log(`✅ Permisos otorgados: ${permissions.length} carpetas`);
    return permissions;
    
  } catch (error) {
    console.error('❌ Error otorgando permisos a carpetas:', error);
    return permissions; // Retornar los permisos que sí se pudieron otorgar
  }
}

// Configurar Nodemailer
let transporter;
try {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransporter({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    // Verificar la configuración al inicializar
    transporter.verify((error, success) => {
      if (error) {
        console.error('Error en la configuración SMTP:', error);
      } else {
        console.log('Servidor SMTP configurado correctamente');
      }
    });
  }
} catch (error) {
  console.error('Error configurando Nodemailer:', error);
}

// Función CORREGIDA para subir DNIs directamente a la subcarpeta "Documentos Personales"
async function uploadDNIImages(drive, carpetaId, dniDelanteFile, dniDetrasFile, driveId = null) {
  const uploadedFiles = {};
  
  try {
    console.log('📋 Iniciando proceso de subida de DNIs...');
    
    // Primero crear/buscar la subcarpeta "Documentos Personales"
    console.log('📁 Creando/buscando subcarpeta "Documentos Personales"...');
    
    const documentosPersonalesFolder = await drive.files.list({
      q: `'${carpetaId}' in parents and mimeType='application/vnd.google-apps.folder' and name='Documentos Personales'`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(driveId && { driveId })
    });

    let documentosPersonalesFolderId;
    
    if (documentosPersonalesFolder.data.files && documentosPersonalesFolder.data.files.length > 0) {
      documentosPersonalesFolderId = documentosPersonalesFolder.data.files[0].id;
      console.log('✅ Subcarpeta "Documentos Personales" encontrada:', documentosPersonalesFolderId);
    } else {
      // Crear la subcarpeta si no existe
      const newFolder = await drive.files.create({
        resource: {
          name: 'Documentos Personales',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [carpetaId]
        },
        supportsAllDrives: true
      });
      documentosPersonalesFolderId = newFolder.data.id;
      console.log('✅ Subcarpeta "Documentos Personales" creada:', documentosPersonalesFolderId);
    }

    // Verificar que los archivos existen antes de intentar subirlos
    if (dniDelanteFile && fs.existsSync(dniDelanteFile.path)) {
      console.log('📤 Subiendo DNI Delante...');
      try {
        const dniDelanteResponse = await drive.files.create({
          resource: {
            name: `DNI_Delante_${Date.now()}_${dniDelanteFile.originalFilename || 'documento.jpg'}`,
            parents: [documentosPersonalesFolderId]
          },
          media: {
            mimeType: dniDelanteFile.headers['content-type'] || 'image/jpeg',
            body: fs.createReadStream(dniDelanteFile.path)
          },
          supportsAllDrives: true
        });
        
        uploadedFiles.dniDelanteUrl = `https://drive.google.com/file/d/${dniDelanteResponse.data.id}/view`;
        uploadedFiles.dniDelanteId = dniDelanteResponse.data.id;
        console.log('✅ DNI Delante subido exitosamente:', dniDelanteResponse.data.id);
        
      } catch (error) {
        console.error('❌ Error subiendo DNI Delante:', error);
        uploadedFiles.dniDelanteError = error.message;
      }
    } else {
      console.warn('⚠️ Archivo DNI Delante no encontrado o no válido:', dniDelanteFile?.path);
    }
    
    // Subir DNI Detrás
    if (dniDetrasFile && fs.existsSync(dniDetrasFile.path)) {
      console.log('📤 Subiendo DNI Detrás...');
      try {
        const dniDetrasResponse = await drive.files.create({
          resource: {
            name: `DNI_Detras_${Date.now()}_${dniDetrasFile.originalFilename || 'documento.jpg'}`,
            parents: [documentosPersonalesFolderId]
          },
          media: {
            mimeType: dniDetrasFile.headers['content-type'] || 'image/jpeg',
            body: fs.createReadStream(dniDetrasFile.path)
          },
          supportsAllDrives: true
        });
        
        uploadedFiles.dniDetrasUrl = `https://drive.google.com/file/d/${dniDetrasResponse.data.id}/view`;
        uploadedFiles.dniDetrasId = dniDetrasResponse.data.id;
        console.log('✅ DNI Detrás subido exitosamente:', dniDetrasResponse.data.id);
        
      } catch (error) {
        console.error('❌ Error subiendo DNI Detrás:', error);
        uploadedFiles.dniDetrasError = error.message;
      }
    } else {
      console.warn('⚠️ Archivo DNI Detrás no encontrado o no válido:', dniDetrasFile?.path);
    }

    console.log('✅ Proceso de subida de DNIs completado');
    console.log('📋 Resumen de archivos subidos:', {
      dniDelante: !!uploadedFiles.dniDelanteUrl,
      dniDetras: !!uploadedFiles.dniDetrasUrl,
      urls: {
        delante: uploadedFiles.dniDelanteUrl,
        detras: uploadedFiles.dniDetrasUrl
      }
    });
    
  } catch (error) {
    console.error('❌ Error general subiendo imágenes DNI:', error);
    uploadedFiles.generalError = error.message;
  }
  
  return uploadedFiles;
}

// Función para enviar email sin bloquear (MEJORADA CON INFORMACIÓN DE ACCESO)
async function sendConfirmationEmail(correo, nombre, empresa, carpetaUrl = null) {
  if (!transporter) {
    console.log('Nodemailer no configurado, saltando envío de email');
    return { success: false, error: 'Transportador no configurado' };
  }

  // Enviar email en background sin bloquear
  setImmediate(async () => {
    try {
      const fechaRegistro = new Date().toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const mailOptions = {
        from: {
          name: process.env.FROM_NAME || 'Sistema de Gestión Documental',
          address: process.env.FROM_EMAIL || process.env.SMTP_USER
        },
        to: correo,
        subject: '🎉 Bienvenido al Sistema de Gestión Documental - Acceso Configurado',
        html: `
          <!DOCTYPE html>
          <html lang="es">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Bienvenido al Sistema</title>
          </head>
          <body style="margin: 0; padding: 20px; font-family: 'Arial', sans-serif; background-color: #f4f4f4;">
            <div style="max-width: 600px; margin: 0 auto; background-color: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              
              <!-- Header -->
              <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 300;">¡Bienvenido al Sistema!</h1>
                <p style="color: #e8f0fe; margin: 10px 0 0 0; font-size: 16px;">Tu registro se ha completado exitosamente</p>
              </div>
              
              <!-- Content -->
              <div style="padding: 40px 30px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                  Hola <strong style="color: #667eea;">${nombre}</strong>,
                </p>
                
                <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
                  Te confirmamos que tu registro en el Sistema de Gestión Documental se ha completado exitosamente y ya tienes acceso a tu carpeta personal de documentos.
                </p>

                ${carpetaUrl ? `
                <!-- Acceso a Carpeta Personal -->
                <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); padding: 25px; border-radius: 8px; margin: 30px 0;">
                  <h3 style="color: white; margin: 0 0 15px 0; font-size: 18px;">📁 Tu Carpeta Personal</h3>
                  <p style="color: white; margin: 0 0 15px 0;">Ya puedes acceder a tu carpeta personal de documentos:</p>
                  <div style="text-align: center;">
                    <a href="${carpetaUrl}" 
                       style="display: inline-block; background: rgba(255,255,255,0.2); color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; font-weight: bold; border: 2px solid white;">
                      🔗 Acceder a Mi Carpeta
                    </a>
                  </div>
                </div>
                ` : ''}
                
                <!-- Info Box -->
                <div style="background: linear-gradient(135deg,rgb(200, 227, 248) 0%, #7bbbea 100%); padding: 25px; border-radius: 8px; margin: 30px 0;">
                  <h3 style="color: white; margin: 0 0 15px 0; font-size: 18px;">📋 Datos de tu registro</h3>
                  <table style="width: 100%; color: white;">
                    <tr>
                      <td style="padding: 5px 0; font-weight: bold;">Nombre:</td>
                      <td style="padding: 5px 0;">${nombre}</td>
                    </tr>
                    <tr>
                      <td style="padding: 5px 0; font-weight: bold;">Empresa:</td>
                      <td style="padding: 5px 0;">${empresa}</td>
                    </tr>
                    <tr>
                      <td style="padding: 5px 0; font-weight: bold;">Email:</td>
                      <td style="padding: 5px 0;">${correo}</td>
                    </tr>
                    <tr>
                      <td style="padding: 5px 0; font-weight: bold;">Fecha:</td>
                      <td style="padding: 5px 0;">${fechaRegistro}</td>
                    </tr>
                  </table>
                </div>
                
                <!-- Features -->
                <div style="margin: 30px 0;">
                  <h3 style="color: #333; margin-bottom: 20px; font-size: 18px;">🚀 ¿Qué puedes hacer ahora?</h3>
                  <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #667eea;">
                    <ul style="margin: 0; padding-left: 20px; color: #666;">
                      <li style="margin-bottom: 10px; line-height: 1.6;">✅ Acceder a tu carpeta personal desde Google Drive</li>
                      <li style="margin-bottom: 10px; line-height: 1.6;">✅ Ver y descargar tus documentos personales</li>
                      <li style="margin-bottom: 10px; line-height: 1.6;">✅ Consultar nóminas, contratos y certificados</li>
                      <li style="margin-bottom: 10px; line-height: 1.6;">✅ Recibir notificaciones de nuevos archivos</li>
                      <li style="margin-bottom: 0; line-height: 1.6;">✅ Gestionar y revisar tus documentos laborales</li>
                    </ul>
                  </div>
                </div>
                
                <!-- Important Note -->
                <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin: 30px 0;">
                  <h4 style="color: #856404; margin: 0 0 10px 0; font-size: 16px;">📧 Importante</h4>
                  <p style="color: #856404; margin: 0; font-size: 14px; line-height: 1.5;">
                    Es posible que hayas recibido una notificación de Google Drive sobre el acceso a tu carpeta. 
                    Esto es normal y confirma que ya puedes acceder a tus documentos.
                  </p>
                </div>
                
                <!-- CTA Button -->
                <div style="text-align: center; margin: 40px 0;">
                  <a href="${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app/'}" 
                     style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3); transition: transform 0.2s;">
                    🔗 Acceder al Sistema
                  </a>
                </div>
              </div>
              
              <!-- Footer -->
              <div style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #dee2e6;">
                <p style="color: #6c757d; font-size: 12px; margin: 0 0 10px 0;">
                  Este email se ha enviado automáticamente desde el Sistema de Gestión Documental.
                </p>
                <p style="color: #868e96; font-size: 11px; margin: 0;">
                  Por favor, no respondas a este mensaje. © ${new Date().getFullYear()} Sistema de Gestión Documental.
                </p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `
¡Bienvenido al Sistema de Gestión Documental!

Hola ${nombre},

Te confirmamos que tu registro se ha completado exitosamente y ya tienes acceso a tu carpeta personal de documentos.

DATOS DE TU REGISTRO:
• Nombre: ${nombre}
• Empresa: ${empresa}
• Email: ${correo}
• Fecha: ${fechaRegistro}

${carpetaUrl ? `
TU CARPETA PERSONAL:
${carpetaUrl}
` : ''}

¿QUÉ PUEDES HACER AHORA?
✅ Acceder a tu carpeta personal desde Google Drive
✅ Ver y descargar tus documentos personales
✅ Consultar nóminas, contratos y certificados
✅ Recibir notificaciones de nuevos archivos
✅ Gestionar y revisar tus documentos laborales

ACCEDER AL SISTEMA:
${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app/'}

IMPORTANTE: Es posible que hayas recibido una notificación de Google Drive sobre el acceso a tu carpeta. Esto es normal y confirma que ya puedes acceder a tus documentos.

© ${new Date().getFullYear()} Sistema de Gestión Documental.
        `
      };

      const result = await transporter.sendMail(mailOptions);
      console.log('✅ Email enviado exitosamente:', result.messageId);

    } catch (error) {
      console.error('❌ Error enviando email:', error.message);
    }
  });

  // Retornar inmediatamente sin esperar
  return { success: true, messageId: 'pending' };
}

// Función para parsear FormData usando multiparty
function parseFormData(event) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form();
    
    // Convertir el body si viene en base64
    let bodyBuffer;
    if (event.isBase64Encoded) {
      bodyBuffer = Buffer.from(event.body, 'base64');
    } else {
      bodyBuffer = Buffer.from(event.body);
    }

    // Crear un stream readable del body
    const { Readable } = require('stream');
    const bodyStream = new Readable();
    bodyStream.push(bodyBuffer);
    bodyStream.push(null);
    
    // Agregar headers y método requeridos por multiparty
    bodyStream.headers = event.headers;
    bodyStream.method = 'POST';

    const fields = {};
    const files = {};

    form.on('field', (name, value) => {
      fields[name] = value;
    });

    form.on('part', (part) => {
      if (part.filename) {
        // Es un archivo
        const chunks = [];
        part.on('data', (chunk) => {
          chunks.push(chunk);
        });
        part.on('end', () => {
          files[part.name] = {
            originalFilename: part.filename,
            headers: part.headers,
            buffer: Buffer.concat(chunks)
          };
        });
      }
    });

    form.on('error', (err) => {
      reject(err);
    });

    form.on('close', () => {
      resolve({ fields, files });
    });

    // Parsear el stream
    form.parse(bodyStream);
  });
}

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  }

  let tempFilePaths = [];

  try {
    // Parsear FormData
    let formData;
    try {
      // Verificar si es JSON (fallback para compatibilidad)
      if (event.headers['content-type'] && event.headers['content-type'].includes('application/json')) {
        // Mantener compatibilidad con requests JSON antiguos
        const jsonData = JSON.parse(event.body);
        formData = {
          fields: jsonData,
          files: {
            dniDelante: jsonData.dniDelante ? { buffer: Buffer.from(jsonData.dniDelante.split(',')[1], 'base64'), originalFilename: jsonData.dniDelanteNombre } : null,
            dniDetras: jsonData.dniDetras ? { buffer: Buffer.from(jsonData.dniDetras.split(',')[1], 'base64'), originalFilename: jsonData.dniDetrasNombre } : null
          }
        };
      } else {
        // Parsear como FormData
        formData = await parseFormData(event);
      }
    } catch (parseError) {
      console.error('Error parseando datos:', parseError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Error procesando los datos del formulario' })
      };
    }

    const { fields, files } = formData;
    const { 
      nombre, dni, correo, telefono, direccion, empresa, talla
    } = fields;

    // Validaciones básicas
    if (!nombre || !dni || !correo || !telefono || !direccion || !empresa || !talla) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Todos los campos son obligatorios' })
      };
    }

    // Validar que se hayan subido las fotos del DNI
    if (!files.dniDelante || !files.dniDetras) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Debes subir ambas fotos del DNI (delante y detrás)' })
      };
    }

    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'El formato del correo electrónico no es válido' })
      };
    }

    // Procesar la clave privada
    const privateKey = processPrivateKey(process.env.GOOGLE_PRIVATE_KEY);

    // Configurar autenticación con Google
    const auth = new GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: privateKey,
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.GOOGLE_CLIENT_EMAIL}`,
        universe_domain: 'googleapis.com'
      },
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    // Verificar si el trabajador ya existe (optimizado con timeout)
    const checkExistingPromise = sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Trabajadores!B:C'
    }).then(response => {
      const existingRows = response.data.values || [];
      return existingRows.find(row => row[0] === dni || row[1] === correo);
    });

    // Dar máximo 2 segundos para verificar
    const existingWorker = await Promise.race([
      checkExistingPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 2000))
    ]);

    if (existingWorker) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Ya existe un trabajador registrado con ese DNI o correo electrónico' })
      };
    }

    // Generar ID interno
    const idInterno = `WRK-${Date.now()}`;
    const fechaIncorporacion = new Date().toLocaleDateString('es-ES');

    // 1. VERIFICAR SI LA CARPETA PADRE ESTÁ EN UN SHARED DRIVE
    console.log('🔍 Verificando información de la carpeta padre...');
    const parentFolderInfo = await getFileInfo(drive, process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
    
    if (!parentFolderInfo) {
      console.error('❌ No se pudo acceder a la carpeta padre. Verifica el ID y los permisos.');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'No se pudo acceder a la carpeta padre en Google Drive. Verifica la configuración.' 
        })
      };
    }

    console.log('📂 Información de carpeta padre:', {
      id: parentFolderInfo.id,
      name: parentFolderInfo.name,
      driveId: parentFolderInfo.driveId,
      isSharedDrive: !!parentFolderInfo.driveId
    });

    // 2. CREAR CARPETA PRINCIPAL CON SOPORTE PARA SHARED DRIVES
    console.log('📁 Creando carpeta principal en Google Drive...');
    const carpetaMetadata = {
      name: `${nombre} - ${empresa}`,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID]
    };

    const carpetaResponse = await drive.files.create({
      resource: carpetaMetadata,
      fields: 'id',
      supportsAllDrives: true
    });

    const carpetaId = carpetaResponse.data.id;
    const carpetaUrl = `https://drive.google.com/drive/folders/${carpetaId}`;
    console.log('✅ Carpeta principal creada:', carpetaUrl);

    // 3. CREAR SUBCARPETAS CON SOPORTE PARA SHARED DRIVES
    const subcarpetas = [
      'Nóminas',
      'Contratos',
      'Formación',
      'Certificados',
      'Documentos Personales',
      'Pendiente de Firma'
    ];

    // CREAR ARCHIVOS TEMPORALES PARA DNI ANTES DE PROCESAR
    console.log('💾 Creando archivos temporales para DNI...');
    const timestamp = Date.now();
    const dniDelantePath = path.join(os.tmpdir(), `dni_delante_${timestamp}.jpg`);
    const dniDetrasPath = path.join(os.tmpdir(), `dni_detras_${timestamp}.jpg`);
    
    // Escribir los buffers a archivos temporales
    fs.writeFileSync(dniDelantePath, files.dniDelante.buffer);
    fs.writeFileSync(dniDetrasPath, files.dniDetras.buffer);
    
    // Agregar a la lista de archivos a limpiar
    tempFilePaths = [dniDelantePath, dniDetrasPath];
    
    console.log('✅ Archivos temporales creados:', {
      delante: dniDelantePath,
      detras: dniDetrasPath,
      delanteExists: fs.existsSync(dniDelantePath),
      detrasExists: fs.existsSync(dniDetrasPath)
    });

    const dniDelanteFile = {
      path: dniDelantePath,
      originalFilename: files.dniDelante.originalFilename,
      headers: files.dniDelante.headers || { 'content-type': 'image/jpeg' }
    };

    const dniDetrasFile = {
      path: dniDetrasPath,
      originalFilename: files.dniDetras.originalFilename,
      headers: files.dniDetras.headers || { 'content-type': 'image/jpeg' }
    };

    // 4. EJECUTAR PROCESOS EN PARALELO: crear subcarpetas y subir DNIs
    console.log('🚀 Ejecutando procesos en paralelo...');
    
    const [subcarpetasCreadas, dniUrls] = await Promise.all([
      // Crear todas las subcarpetas en paralelo CON SOPORTE PARA SHARED DRIVES
      Promise.all(
        subcarpetas.map(subcarpeta => 
          drive.files.create({
            resource: {
              name: subcarpeta,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [carpetaId]
            },
            supportsAllDrives: true
          }).then(res => ({ nombre: subcarpeta, id: res.data.id }))
            .catch(err => ({ nombre: subcarpeta, id: null, error: err }))
        )
      ),
      
      // Subir imágenes del DNI (pasando el driveId si existe)
      uploadDNIImages(drive, carpetaId, dniDelanteFile, dniDetrasFile, parentFolderInfo.driveId)
    ]);

    // 5. ENVIAR EMAIL DE CONFIRMACIÓN (EN PARALELO, NO BLOQUEANTE)
    const emailPromise = sendConfirmationEmail(correo, nombre, empresa, carpetaUrl);

    // 6. CONFIGURAR PERMISOS DE ACCESO PARA EL TRABAJADOR
    console.log('🔐 Configurando permisos de acceso para el trabajador...');
    
    // Dar acceso en paralelo (sin bloquear si falla)
    const accessPromise = grantWorkerAccessToAllFolders(drive, carpetaId, subcarpetasCreadas, correo)
      .catch(error => {
        console.error('❌ Error configurando permisos:', error);
        return []; // Retornar array vacío si falla
      });

    // No esperar más de 5 segundos por los permisos
    const workerPermissions = await Promise.race([
      accessPromise,
      new Promise(resolve => setTimeout(() => resolve([]), 5000))
    ]);

    // Esperar resultado del email
    const emailResult = await emailPromise;

    // Log subcarpetas creadas
    subcarpetasCreadas.forEach(sub => {
      if (sub.id) {
        console.log(`✅ Subcarpeta ${sub.nombre} creada exitosamente:`, sub.id);
      } else {
        console.warn(`⚠️ Error creando subcarpeta ${sub.nombre}:`, sub.error);
      }
    });

    // Log DNIs subidos
    console.log('📋 Resultado subida DNIs:', {
      delante: !!dniUrls.dniDelanteUrl,
      detras: !!dniUrls.dniDetrasUrl,
      delanteUrl: dniUrls.dniDelanteUrl,
      detrasUrl: dniUrls.dniDetrasUrl,
      errors: {
        delante: dniUrls.dniDelanteError,
        detras: dniUrls.dniDetrasError,
        general: dniUrls.generalError
      }
    });

    // Log permisos otorgados
    if (workerPermissions.length > 0) {
      console.log(`✅ Permisos otorgados al trabajador: ${workerPermissions.length} carpetas`);
    } else {
      console.warn('⚠️ No se pudieron otorgar permisos al trabajador (continuando...)');
    }

    // 7. GUARDAR DATOS EN GOOGLE SHEETS
    console.log('📊 Guardando datos en Google Sheets...');
    
    const rowData = [
      nombre,                           // A: Nombre Completo
      dni,                             // B: DNI/NIE
      correo,                          // C: Correo Electrónico
      telefono,                        // D: Teléfono
      direccion,                       // E: Dirección Completa
      empresa,                         // F: Empresa
      talla,                           // G: Talla Ropa
      idInterno,                       // H: ID Interno
      carpetaUrl,                      // I: Carpeta Drive URL
      'Activo',                        // J: Estado
      fechaIncorporacion,              // K: Fecha Registro
      '',                              // L: Último doc firmado
      '0',                             // M: Total Docs
      '',                              // N: Observaciones
      dniUrls.dniDelanteUrl || '',     // O: DNI delantero
      dniUrls.dniDetrasUrl || ''       // P: DNI trasero
    ];

    // Intentar guardar en Google Sheets con timeout
    let sheetsSaved = false;
    try {
      await Promise.race([
        sheets.spreadsheets.values.append({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: 'Trabajadores!A:P',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [rowData]
          }
        }).then(() => {
          sheetsSaved = true;
          console.log('✅ Datos guardados en Google Sheets');
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);
    } catch (error) {
      console.error('❌ Error guardando en Google Sheets:', error);
      console.log('⚠️ El registro se completó pero no se pudo guardar en la hoja de cálculo');
    }

    // 8. DEVOLVER RESPUESTA EXITOSA
    console.log(`🎉 Registro completado exitosamente para: ${nombre}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Trabajador registrado exitosamente',
        success: true,
        idInterno,
        carpetaUrl,
        workerAccess: {
          granted: workerPermissions.length > 0,
          totalPermissions: workerPermissions.length,
          accessLevel: 'reader',
          notificationSent: workerPermissions.length > 0
        },
        emailSent: emailResult.success,
        emailDetails: emailResult.success ? {
          messageId: emailResult.messageId,
          status: 'enviado'
        } : {
          error: emailResult.error,
          status: 'fallido'
        },
        dniUploaded: {
          delante: !!dniUrls.dniDelanteUrl,
          detras: !!dniUrls.dniDetrasUrl,
          delanteUrl: dniUrls.dniDelanteUrl,
          detrasUrl: dniUrls.dniDetrasUrl,
          uploadErrors: {
            delante: dniUrls.dniDelanteError,
            detras: dniUrls.dniDetrasError,
            general: dniUrls.generalError
          }
        },
        sheetsSaved,
        subcarpetas: subcarpetasCreadas.map(s => ({
          nombre: s.nombre,
          created: !!s.id,
          id: s.id
        })),
        details: {
          nombre,
          empresa,
          correo,
          dni,
          telefono,
          direccion,
          talla,
          fechaRegistro: fechaIncorporacion,
          carpetaCreada: true,
          permisosConfigurados: workerPermissions.length > 0,
          documentosSubidos: {
            total: (dniUrls.dniDelanteUrl ? 1 : 0) + (dniUrls.dniDetrasUrl ? 1 : 0),
            dniDelante: !!dniUrls.dniDelanteUrl,
            dniDetras: !!dniUrls.dniDetrasUrl
          }
        }
      })
    };

  } catch (error) {
    console.error('❌ Error general en el proceso:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Error interno del servidor. Por favor, inténtalo de nuevo en unos minutos.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      })
    };
  } finally {
    // Limpiar archivos temporales AL FINAL del proceso
    console.log('🧹 Iniciando limpieza de archivos temporales...');
    tempFilePaths.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Archivo temporal eliminado: ${filePath}`);
        } else {
          console.log(`⚠️ Archivo temporal no encontrado para eliminar: ${filePath}`);
        }
      } catch (cleanupError) {
        console.warn(`⚠️ No se pudo eliminar archivo temporal: ${filePath}`, cleanupError.message);
      }
    });
    console.log('✅ Limpieza de archivos temporales completada');
  }
};