const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

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
      },
      connectionTimeout: 60000,
      greetingTimeout: 30000,
      socketTimeout: 60000
    });

    // Verificar configuración
    transporter.verify((error, success) => {
      if (error) {
        console.error('Error en la configuración SMTP:', error);
      } else {
        console.log('Servidor SMTP configurado correctamente');
      }
    });
  } else {
    console.warn('Configuración SMTP incompleta');
  }
} catch (error) {
  console.error('Error configurando Nodemailer:', error);
}

// Función simplificada para subir archivos DNI
async function uploadDNIImages(drive, carpetaId, dniDelanteData, dniDetrasData) {
  const uploadedFiles = {};
  
  try {
    // Buscar o crear subcarpeta "Documentos Personales"
    let documentosPersonalesFolderId = carpetaId; // Fallback a carpeta principal
    
    try {
      const subcarpetasResponse = await drive.files.list({
        q: `'${carpetaId}' in parents and mimeType='application/vnd.google-apps.folder' and name='Documentos Personales'`,
        fields: 'files(id, name)'
      });
      
      if (subcarpetasResponse.data.files && subcarpetasResponse.data.files.length > 0) {
        documentosPersonalesFolderId = subcarpetasResponse.data.files[0].id;
      } else {
        const newSubfolderResponse = await drive.files.create({
          resource: {
            name: 'Documentos Personales',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [carpetaId]
          }
        });
        documentosPersonalesFolderId = newSubfolderResponse.data.id;
      }
    } catch (folderError) {
      console.error('Error con subcarpeta, usando carpeta principal:', folderError);
    }
    
    // Subir DNI Delante
    if (dniDelanteData) {
      const dniDelanteResponse = await drive.files.create({
        resource: {
          name: `DNI_Delante_${Date.now()}.jpg`,
          parents: [documentosPersonalesFolderId]
        },
        media: {
          mimeType: 'image/jpeg',
          body: dniDelanteData
        }
      });
      
      uploadedFiles.dniDelanteUrl = `https://drive.google.com/file/d/${dniDelanteResponse.data.id}/view`;
    }
    
    // Subir DNI Detrás
    if (dniDetrasData) {
      const dniDetrasResponse = await drive.files.create({
        resource: {
          name: `DNI_Detras_${Date.now()}.jpg`,
          parents: [documentosPersonalesFolderId]
        },
        media: {
          mimeType: 'image/jpeg',
          body: dniDetrasData
        }
      });
      
      uploadedFiles.dniDetrasUrl = `https://drive.google.com/file/d/${dniDetrasResponse.data.id}/view`;
    }
    
  } catch (error) {
    console.error('Error subiendo imágenes DNI:', error);
    throw error;
  }
  
  return uploadedFiles;
}

// Función para enviar email de confirmación
async function sendConfirmationEmail(correo, nombre, empresa) {
  if (!transporter) {
    console.log('Nodemailer no configurado');
    return { success: false, error: 'Transportador no configurado' };
  }

  try {
    // Validaciones
    if (!correo || !nombre || !empresa) {
      return { success: false, error: 'Datos insuficientes' };
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
      return { success: false, error: 'Email inválido' };
    }

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
        <body style="margin: 0; padding: 20px; font-family: Arial, sans-serif; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 0 auto; background-color: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 300;">¡Bienvenido al Sistema!</h1>
              <p style="color: #e8f0fe; margin: 10px 0 0 0; font-size: 16px;">Tu registro se ha completado exitosamente</p>
            </div>
            
            <div style="padding: 40px 30px;">
              <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                Hola <strong style="color: #667eea;">${nombre}</strong>,
              </p>
              
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
                Te confirmamos que tu registro en el Sistema de Gestión Documental se ha completado exitosamente.
              </p>
              
              <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 25px; border-radius: 8px; margin: 30px 0;">
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
              
              <div style="text-align: center; margin: 40px 0;">
                <a href="${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app'}" 
                   style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px;">
                  🔗 Acceder al Sistema
                </a>
              </div>
            </div>
            
            <div style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #dee2e6;">
              <p style="color: #6c757d; font-size: 12px; margin: 0;">
                © ${new Date().getFullYear()} Sistema de Gestión Documental.
              </p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
Hola ${nombre},

Tu registro en el Sistema de Gestión Documental se ha completado exitosamente.

Datos de tu registro:
- Nombre: ${nombre}
- Empresa: ${empresa}
- Email: ${correo}
- Fecha: ${fechaRegistro}

Accede al sistema en: ${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app'}

Gracias,
Sistema de Gestión Documental
      `
    };

    const result = await transporter.sendMail(mailOptions);
    
    console.log('Email enviado exitosamente:', result.messageId);
    return { 
      success: true, 
      messageId: result.messageId
    };

  } catch (error) {
    console.error('Error enviando email:', error);
    return { 
      success: false, 
      error: error.message
    };
  }
}

// Función simplificada para parsear FormData
function parseFormData(event) {
  try {
    // Primero intentar parsear como JSON
    if (event.headers['content-type'] && event.headers['content-type'].includes('application/json')) {
      const jsonData = JSON.parse(event.body);
      return {
        fields: jsonData,
        files: {
          dniDelante: jsonData.dniDelante ? {
            buffer: Buffer.from(jsonData.dniDelante.split(',')[1], 'base64'),
            originalFilename: jsonData.dniDelanteNombre || 'dni_delante.jpg'
          } : null,
          dniDetras: jsonData.dniDetras ? {
            buffer: Buffer.from(jsonData.dniDetras.split(',')[1], 'base64'),
            originalFilename: jsonData.dniDetrasNombre || 'dni_detras.jpg'
          } : null
        }
      };
    }

    // Si no es JSON, intentar parsear multipart (implementación básica)
    const boundary = event.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
      throw new Error('No se encontró boundary en multipart');
    }

    // Para simplificar, devolver estructura básica
    // En producción, considera usar una librería más robusta
    return {
      fields: {},
      files: {}
    };

  } catch (error) {
    console.error('Error parseando FormData:', error);
    throw error;
  }
}

exports.handler = async (event, context) => {
  // Headers CORS
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

  try {
    console.log('🚀 Iniciando registro de trabajador...');
    console.log('Headers recibidos:', JSON.stringify(event.headers, null, 2));

    // Validar variables de entorno críticas
    const requiredEnvVars = [
      'GOOGLE_PROJECT_ID',
      'GOOGLE_PRIVATE_KEY',
      'GOOGLE_CLIENT_EMAIL',
      'GOOGLE_SHEET_ID',
      'GOOGLE_DRIVE_PARENT_FOLDER_ID'
    ];

    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingEnvVars.length > 0) {
      console.error('Variables de entorno faltantes:', missingEnvVars);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Configuración del servidor incompleta',
          missing: missingEnvVars
        })
      };
    }

    // Parsear datos del formulario
    let formData;
    try {
      formData = parseFormData(event);
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

    console.log('Datos recibidos:', { nombre, dni, correo, empresa });

    // Validaciones
    if (!nombre || !dni || !correo || !telefono || !direccion || !empresa || !talla) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Todos los campos son obligatorios' })
      };
    }

    // Validar email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'El formato del correo electrónico no es válido' })
      };
    }

    // Configurar Google Auth
    console.log('🔐 Configurando autenticación Google...');
    const auth = new GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.GOOGLE_CLIENT_EMAIL}`
      },
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    // Verificar trabajador existente
    console.log('🔍 Verificando trabajador existente...');
    try {
      const existingResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Trabajadores!B:C'
      });

      const existingRows = existingResponse.data.values || [];
      const existingWorker = existingRows.find(row => 
        row[0] === dni || row[1] === correo
      );

      if (existingWorker) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ error: 'Ya existe un trabajador registrado con ese DNI o correo electrónico' })
        };
      }
    } catch (checkError) {
      console.error('Error verificando trabajador existente:', checkError);
    }

    // Generar datos
    const idInterno = `WRK-${Date.now()}`;
    const fechaIncorporacion = new Date().toLocaleDateString('es-ES');

    console.log('📁 Creando carpeta en Google Drive...');
    // Crear carpeta en Drive
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

    console.log('📂 Creando subcarpetas...');
    // Crear subcarpetas
    const subcarpetas = [
      'Nóminas', 
      'Contratos', 
      'Documentos Personales',
      'Formación',
      'Certificados'
    ];
    
    for (const subcarpeta of subcarpetas) {
      try {
        await drive.files.create({
          resource: {
            name: subcarpeta,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [carpetaId]
          }
        });
      } catch (subfolderError) {
        console.error(`Error creando subcarpeta ${subcarpeta}:`, subfolderError);
      }
    }

    // Subir imágenes DNI (si existen)
    let dniUrls = {};
    if (files.dniDelante && files.dniDetras) {
      console.log('📷 Subiendo imágenes DNI...');
      try {
        const { Readable } = require('stream');
        
        const dniDelanteStream = new Readable();
        dniDelanteStream.push(files.dniDelante.buffer);
        dniDelanteStream.push(null);

        const dniDetrasStream = new Readable();
        dniDetrasStream.push(files.dniDetras.buffer);
        dniDetrasStream.push(null);

        dniUrls = await uploadDNIImages(drive, carpetaId, dniDelanteStream, dniDetrasStream);
      } catch (uploadError) {
        console.error('Error subiendo imágenes DNI:', uploadError);
        // Continuar sin las imágenes
      }
    }

    console.log('📝 Añadiendo registro a Google Sheets...');
    // Añadir a Sheets
    const valores = [
      [
        nombre,
        dni,
        correo,
        telefono,
        direccion,
        empresa,
        talla,
        idInterno,
        carpetaUrl,
        'Activo',
        fechaIncorporacion,
        '',
        '0',
        'Registro completado',
        dniUrls.dniDelanteUrl || '',
        dniUrls.dniDetrasUrl || ''
      ]
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Trabajadores!A:P',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: valores
      }
    });

    // Enviar email
    console.log('📧 Enviando email de confirmación...');
    const emailResult = await sendConfirmationEmail(correo, nombre, empresa);

    console.log('✅ Registro completado exitosamente');
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
        details: {
          nombre,
          empresa,
          correo,
          fechaRegistro: fechaIncorporacion
        }
      })
    };

  } catch (error) {
    console.error('💥 Error general:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Error interno del servidor',
        details: process.env.NODE_ENV === 'development' ? error.message : 'Por favor, inténtalo de nuevo'
      })
    };
  }
};