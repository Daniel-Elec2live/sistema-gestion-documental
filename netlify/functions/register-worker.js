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

// Configurar Nodemailer
let transporter;
try {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
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

// Función optimizada para subir DNIs
async function uploadDNIImages(drive, carpetaId, dniDelanteFile, dniDetrasFile) {
  const uploadedFiles = {};
  
  try {
    // Buscar o crear subcarpeta "Documentos Personales" en paralelo con las subidas
    const [documentosPersonalesFolderId, dniDelanteUpload, dniDetrasUpload] = await Promise.all([
      // Buscar/crear subcarpeta
      drive.files.list({
        q: `'${carpetaId}' in parents and mimeType='application/vnd.google-apps.folder' and name='Documentos Personales'`,
        fields: 'files(id, name)'
      }).then(async (response) => {
        if (response.data.files && response.data.files.length > 0) {
          return response.data.files[0].id;
        } else {
          const newFolder = await drive.files.create({
            resource: {
              name: 'Documentos Personales',
              mimeType: 'application/vnd.google-apps.folder',
              parents: [carpetaId]
            }
          });
          return newFolder.data.id;
        }
      }).catch(() => carpetaId), // Si falla, usar carpeta principal
      
      // Subir DNI Delante (si existe)
      dniDelanteFile && fs.existsSync(dniDelanteFile.path) ? 
        drive.files.create({
          resource: {
            name: `DNI_Delante_${dniDelanteFile.originalFilename || 'documento.jpg'}`,
            parents: [carpetaId] // Temporalmente en carpeta principal
          },
          media: {
            mimeType: dniDelanteFile.headers['content-type'] || 'image/jpeg',
            body: fs.createReadStream(dniDelanteFile.path)
          }
        }).then(res => res.data.id).catch(() => null) : Promise.resolve(null),
      
      // Subir DNI Detrás (si existe)
      dniDetrasFile && fs.existsSync(dniDetrasFile.path) ?
        drive.files.create({
          resource: {
            name: `DNI_Detras_${dniDetrasFile.originalFilename || 'documento.jpg'}`,
            parents: [carpetaId] // Temporalmente en carpeta principal
          },
          media: {
            mimeType: dniDetrasFile.headers['content-type'] || 'image/jpeg',
            body: fs.createReadStream(dniDetrasFile.path)
          }
        }).then(res => res.data.id).catch(() => null) : Promise.resolve(null)
    ]);
    
    // Mover archivos a subcarpeta si es necesario (no crítico, puede fallar)
    if (documentosPersonalesFolderId !== carpetaId) {
      const movePromises = [];
      
      if (dniDelanteUpload) {
        movePromises.push(
          drive.files.update({
            fileId: dniDelanteUpload,
            addParents: documentosPersonalesFolderId,
            removeParents: carpetaId
          }).catch(() => {})
        );
      }
      
      if (dniDetrasUpload) {
        movePromises.push(
          drive.files.update({
            fileId: dniDetrasUpload,
            addParents: documentosPersonalesFolderId,
            removeParents: carpetaId
          }).catch(() => {})
        );
      }
      
      // No esperar mucho por los movimientos
      await Promise.race([
        Promise.all(movePromises),
        new Promise(resolve => setTimeout(resolve, 1000))
      ]);
    }
    
    // Construir URLs
    if (dniDelanteUpload) {
      uploadedFiles.dniDelanteUrl = `https://drive.google.com/file/d/${dniDelanteUpload}/view`;
    }
    if (dniDetrasUpload) {
      uploadedFiles.dniDetrasUrl = `https://drive.google.com/file/d/${dniDetrasUpload}/view`;
    }
    
  } catch (error) {
    console.error('❌ Error subiendo imágenes DNI:', error);
  }
  
  return uploadedFiles;
}

// Función para enviar email sin bloquear
async function sendConfirmationEmail(correo, nombre, empresa) {
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
        subject: '🎉 Bienvenido al Sistema de Gestión Documental',
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
                  Te confirmamos que tu registro en el Sistema de Gestión Documental se ha completado exitosamente.
                </p>
                
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
                      <li style="margin-bottom: 10px; line-height: 1.6;">✅ Ver y descargar tus documentos personales</li>
                      <li style="margin-bottom: 10px; line-height: 1.6;">✅ Consultar nóminas, contratos y otros documentos</li>
                      <li style="margin-bottom: 10px; line-height: 1.6;">✅ Recibir notificaciones de nuevos archivos</li>
                      <li style="margin-bottom: 0; line-height: 1.6;">✅ Gestionar y firmar tus documentos</li>
                    </ul>
                  </div>
                </div>
                
                <!-- CTA Button -->
                <div style="text-align: center; margin: 40px 0;">
                  <a href="${process.env.APP_URL || 'https://tu-dominio.com'}" 
                     style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3); transition: transform 0.2s;">
                    🔗 Acceder al Sistema
                  </a>
                </div>
                
                <!-- Help Section -->
                <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin: 30px 0;">
                  <h4 style="color: #856404; margin: 0 0 10px 0; font-size: 16px;">💡 ¿Necesitas ayuda?</h4>
                  <p style="color: #856404; margin: 0; font-size: 14px; line-height: 1.5;">
                    Si tienes alguna pregunta o necesitas ayuda, no dudes en contactar con el administrador del sistema.
                  </p>
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

Te confirmamos que tu registro se ha completado exitosamente.

DATOS DE TU REGISTRO:
• Nombre: ${nombre}
• Empresa: ${empresa}
• Email: ${correo}
• Fecha: ${fechaRegistro}

¿QUÉ PUEDES HACER AHORA?
✅ Acceder a tus documentos personales
✅ Consultar nóminas y contratos
✅ Recibir notificaciones de nuevos documentos
✅ Gestionar tu perfil

ACCEDER AL SISTEMA:
${process.env.APP_URL || 'https://tu-dominio.com'}

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

    // 1. Crear carpeta en Google Drive
    console.log('📁 Creando carpeta principal en Google Drive...');
    const carpetaMetadata = {
      name: `${nombre} - ${empresa}`,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID]
    };

    const carpetaResponse = await drive.files.create({
      resource: carpetaMetadata,
      fields: 'id'
    });

    const carpetaId = carpetaResponse.data.id;
    const carpetaUrl = `https://drive.google.com/drive/folders/${carpetaId}`;
    console.log('✅ Carpeta principal creada:', carpetaUrl);

    // 2. Crear subcarpetas y subir DNIs en PARALELO
    const subcarpetas = [
      'Nóminas',
      'Contratos',
      'Formación',
      'Certificados',
      'Pendiente de Firma'
    ];

    // Crear archivos temporales para DNI
    const dniDelantePath = path.join(os.tmpdir(), `dni_delante_${Date.now()}.jpg`);
    const dniDetrasPath = path.join(os.tmpdir(), `dni_detras_${Date.now()}.jpg`);
    
    fs.writeFileSync(dniDelantePath, files.dniDelante.buffer);
    fs.writeFileSync(dniDetrasPath, files.dniDetras.buffer);
    
    tempFilePaths = [dniDelantePath, dniDetrasPath];

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

    // Ejecutar en paralelo: crear subcarpetas, subir DNIs y enviar email
    const [subcarpetasCreadas, dniUrls, emailResult] = await Promise.all([
      // Crear todas las subcarpetas en paralelo
      Promise.all(
        subcarpetas.map(subcarpeta => 
          drive.files.create({
            resource: {
              name: subcarpeta,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [carpetaId]
            }
          }).then(res => ({ nombre: subcarpeta, id: res.data.id }))
            .catch(err => ({ nombre: subcarpeta, id: null, error: err }))
        )
      ),
      
      // Subir imágenes del DNI
      uploadDNIImages(drive, carpetaId, dniDelanteFile, dniDetrasFile),
      
      // Enviar email de confirmación (no bloqueante)
      sendConfirmationEmail(correo, nombre, empresa)
    ]);

    // Log subcarpetas creadas
    subcarpetasCreadas.forEach(sub => {
      if (sub.id) {
        console.log(`Subcarpeta ${sub.nombre} creada exitosamente:`, sub.id);
      }
    });

    // 3. Añadir fila a Google Sheets (con timeout)
    console.log('📊 Insertando datos en Google Sheets...');
    const sheetsInsertPromise = sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Trabajadores!A:P',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [
          [
            nombre,                    // A: Nombre completo
            dni,                      // B: DNI/NIE
            correo,                   // C: Correo
            telefono,                 // D: Teléfono
            direccion,                // E: Dirección
            empresa,                  // F: Empresa
            talla,                    // G: Talla
            idInterno,                // H: ID interno
            carpetaUrl,               // I: Carpeta Drive URL
            'Activo',                 // J: Estado
            fechaIncorporacion,       // K: Fecha incorporación
            '',                       // L: Último doc firmado
            '0',                      // M: Total docs
            'Registro completado',    // N: Observaciones
            dniUrls.dniDelanteUrl || '', // O: URL DNI Delante
            dniUrls.dniDetrasUrl || ''   // P: URL DNI Detrás
          ]
        ]
      }
    });

    // Dar máximo 3 segundos para insertar en Sheets
    await Promise.race([
      sheetsInsertPromise,
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    
    console.log('✅ Proceso de registro completado');

    // 5. Devolver respuesta exitosa
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Trabajador registrado exitosamente',
        idInterno,
        carpetaUrl,
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
          detras: !!dniUrls.dniDetrasUrl
        },
        details: {
          nombre,
          empresa,
          correo,
          fechaRegistro: fechaIncorporacion
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
    // Limpiar archivos temporales
    console.log('🧹 Limpiando archivos temporales...');
    tempFilePaths.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`✅ Archivo temporal eliminado: ${path.basename(filePath)}`);
        }
      } catch (cleanupError) {
        console.error('Error limpiando archivo temporal:', cleanupError);
      }
    });
  }
};