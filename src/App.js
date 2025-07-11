import React, { useState, useEffect } from 'react';
import './App.css';

// Configuración de API para desarrollo y producción
const API_BASE = process.env.NODE_ENV === 'production' 
  ? '/.netlify/functions' 
  : 'http://localhost:8888/.netlify/functions';

// Detectar móvil
const isMobile = /Mobi|Android/i.test(navigator.userAgent);

// Componente Loading Spinner
const LoadingSpinner = ({ message = 'Procesando...' }) => (
  <div style={{
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999
  }}>
    <div style={{
      width: '60px',
      height: '60px',
      border: '5px solid #f3f3f3',
      borderTop: '5px solid #667eea',
      borderRadius: '50%',
      animation: 'spin 1s linear infinite'
    }}></div>
    <p style={{
      color: 'white',
      marginTop: '20px',
      fontSize: '18px',
      fontWeight: 'bold'
    }}>{message}</p>
    {isMobile && (
      <p style={{
        color: '#ccc',
        marginTop: '10px',
        fontSize: '14px'
      }}>Esto puede tardar un poco más en móvil...</p>
    )}
  </div>
);

// Función de compresión de imágenes para móviles
const compressImageForMobile = (file, quality = 0.7) => {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    img.onload = () => {
      // Calcular nuevas dimensiones (máximo 1920x1080 para móviles)
      const maxWidth = isMobile ? 1920 : 2560;
      const maxHeight = isMobile ? 1080 : 1440;
      
      let { width, height } = img;
      
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width *= ratio;
        height *= ratio;
      }

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(img, 0, 0, width, height);
      
      canvas.toBlob(resolve, 'image/jpeg', quality);
    };

    img.src = URL.createObjectURL(file);
  });
};

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('Procesando...');
  const [message, setMessage] = useState('');

  // Registro de trabajador - Campos de dirección separados + DNI fotos
  const [formData, setFormData] = useState({
    nombre: '', dni: '', correo: '', telefono: '', 
    calle: '', numero: '', codigoPostal: '', localidad: '', provincia: '',
    empresa: '', talla: '', 
    dniDelante: null, dniDetras: null
  });

  // Dashboard trabajador
  const [loginData, setLoginData] = useState({ dni: '', correo: '' });
  const [workerInfo, setWorkerInfo] = useState(null);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [navigationPath, setNavigationPath] = useState([]);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Auto-ocultar mensajes después de 5 segundos
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => {
        setMessage('');
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Log inicial para debug
  useEffect(() => {
    console.log(`📱 App inicializada - Móvil: ${isMobile}`);
    console.log(`🌐 API Base: ${API_BASE}`);
    console.log(`🔧 User Agent: ${navigator.userAgent}`);
  }, []);

  // Agregar estilos para la animación del spinner
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const handleInputChange = (e, form = 'register') => {
    const { name, value } = e.target;
    if (form === 'register') {
      setFormData(prev => ({ ...prev, [name]: value }));
    } else {
      setLoginData(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleFileChange = async (e) => {
    const { name, files } = e.target;
    const file = files[0];
    
    if (!file) return;

    try {
      console.log(`📎 Archivo seleccionado: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);

      // Validar tamaño inicial (max 20MB)
      if (file.size > 20 * 1024 * 1024) {
        setMessage('❌ La imagen es demasiado grande. Máximo 20MB.');
        e.target.value = '';
        return;
      }
      
      // Validar tipo
      if (!file.type.startsWith('image/')) {
        setMessage('❌ Solo se permiten archivos de imagen.');
        e.target.value = '';
        return;
      }

      let processedFile = file;

      // Comprimir para móviles si es necesario
      if (isMobile && file.size > 5 * 1024 * 1024) {
        console.log('📱 Comprimiendo imagen para móvil...');
        setMessage('📱 Optimizando imagen para móvil...');
        
        try {
          const compressedBlob = await compressImageForMobile(file, 0.7);
          
          // Crear File desde Blob
          processedFile = new File([compressedBlob], file.name.replace(/\.[^/.]+$/, '_compressed.jpg'), {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          
          console.log(`✅ Imagen comprimida: ${file.size} → ${processedFile.size}`);
          
          setMessage('✅ Imagen optimizada correctamente');
          setTimeout(() => setMessage(''), 2000);
        } catch (compressionError) {
          console.error('❌ Error comprimiendo imagen:', compressionError);
          setMessage('⚠️ No se pudo comprimir la imagen, usando original');
          processedFile = file;
        }
      }
      
      setFormData(prev => ({ ...prev, [name]: processedFile }));
      
    } catch (error) {
      console.error('❌ Error procesando archivo:', error);
      setMessage('❌ Error procesando la imagen');
      e.target.value = '';
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    
    if (loading) {
      console.log('⏳ Envío en proceso, ignorando...');
      return;
    }

    setLoading(true);
    setLoadingMessage('Registrando trabajador...');
    setMessage('');

    try {
      console.log('🚀 Iniciando registro...');
      
      // Validaciones adicionales
      if (!formData.dniDelante || !formData.dniDetras) {
        setMessage('❌ Debes subir ambas fotos del DNI');
        setLoading(false);
        return;
      }

      // Construir dirección completa
      const direccionCompleta = `${formData.calle} ${formData.numero}, ${formData.codigoPostal} ${formData.localidad}, ${formData.provincia}`;
      
      // Crear FormData
      const formDataToSend = new FormData();
      
      // Agregar datos de texto
      formDataToSend.append('nombre', formData.nombre);
      formDataToSend.append('dni', formData.dni);
      formDataToSend.append('correo', formData.correo);
      formDataToSend.append('telefono', formData.telefono);
      formDataToSend.append('direccion', direccionCompleta);
      formDataToSend.append('empresa', formData.empresa);
      formDataToSend.append('talla', formData.talla);
      
      // Agregar archivos
      formDataToSend.append('dniDelante', formData.dniDelante);
      formDataToSend.append('dniDetras', formData.dniDetras);

      console.log('📤 Enviando formulario a:', `${API_BASE}/register-worker`);
      console.log('📊 Datos del formulario:', {
        nombre: formData.nombre,
        dni: formData.dni,
        correo: formData.correo,
        empresa: formData.empresa,
        dniDelanteSize: formData.dniDelante?.size,
        dniDetrasSize: formData.dniDetras?.size
      });

      // Actualizar mensaje de loading según progreso
      setTimeout(() => {
        if (loading) setLoadingMessage('Creando carpetas en Google Drive...');
      }, 3000);
      
      setTimeout(() => {
        if (loading) setLoadingMessage('Subiendo documentos...');
      }, 8000);

      setTimeout(() => {
        if (loading) setLoadingMessage('Configurando permisos...');
      }, 15000);

      // Timeout más largo para móviles
      const timeoutMs = isMobile ? 90000 : 45000; // 90s móvil, 45s escritorio
      
      const fetchPromise = fetch(`${API_BASE}/register-worker`, {
        method: 'POST',
        body: formDataToSend
        // NO establecer Content-Type header cuando uses FormData
      });

      const response = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout - La operación tardó demasiado')), timeoutMs)
        )
      ]);

      console.log('📡 Respuesta recibida:', response.status, response.statusText);

      const result = await response.json();
      console.log('📋 Resultado del servidor:', result);

      if (response.ok) {
        setMessage('✅ Trabajador registrado exitosamente. Recibirás un email de confirmación en breve.');
        
        // Resetear formulario
        setFormData({ 
          nombre: '', dni: '', correo: '', telefono: '', 
          calle: '', numero: '', codigoPostal: '', localidad: '', provincia: '',
          empresa: '', talla: '', dniDelante: null, dniDetras: null
        });
        
        // Limpiar inputs de archivo
        const fileInputs = document.querySelectorAll('input[type="file"]');
        fileInputs.forEach(input => input.value = '');
        
        // Mostrar información adicional si está disponible
        if (result.processingTime) {
          console.log(`⏱️ Tiempo de procesamiento: ${result.processingTime}ms`);
        }
        
        // Mostrar advertencia si el email no se configuró
        if (!result.emailSent) {
          setTimeout(() => {
            setMessage('⚠️ Nota: El servidor de email no está configurado. No recibirás email de confirmación.');
          }, 3000);
        }
        
      } else {
        setMessage(`❌ Error: ${result.error || 'Error desconocido'}`);
        
        // Log adicional para debug
        if (result.details) {
          console.error('📋 Detalles del error:', result.details);
        }
        
        if (result.camposFaltantes) {
          console.error('📋 Campos faltantes:', result.camposFaltantes);
        }
        
        if (result.archivosRecibidos) {
          console.error('📋 Archivos recibidos:', result.archivosRecibidos);
        }
      }
    } catch (error) {
      console.error('❌ Error en registro:', error);
      
      if (error.message.includes('Timeout')) {
        setMessage('⏰ La operación tardó más de lo esperado. Por favor, verifica tu conexión e inténtalo de nuevo.');
      } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
        setMessage('🌐 Error de conexión. Verifica tu conexión a internet.');
      } else {
        setMessage('❌ Error de conexión. Por favor, inténtalo de nuevo.');
      }
    } finally {
      setLoading(false);
      setLoadingMessage('Procesando...');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setLoadingMessage('Accediendo a tus documentos...');
    setMessage('');

    try {
      console.log('🔐 Iniciando login con:', loginData);
      
      const response = await fetch(`${API_BASE}/worker-documents`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(loginData)
      });

      const result = await response.json();
      console.log('📋 Respuesta del servidor:', result);

      if (response.ok) {
        setWorkerInfo(result.workerInfo);
        setCurrentFolder(result.folderStructure);
        setNavigationPath([{ nombre: result.folderStructure.nombre, folder: result.folderStructure }]);
        setIsLoggedIn(true);
        setMessage('✅ Acceso exitoso');
      } else {
        setMessage(`❌ ${result.error || 'Error al acceder'}`);
      }
    } catch (error) {
      console.error('❌ Error en login:', error);
      setMessage('❌ Error de conexión. Por favor, inténtalo de nuevo.');
    } finally {
      setLoading(false);
      setLoadingMessage('Procesando...');
    }
  };

  const navigateToFolder = (folder) => {
    // Verificar si la carpeta tiene contenido real (documentos o subcarpetas con contenido)
    const hasContent = isFolderWithContent(folder);
    
    if (hasContent) {
      setCurrentFolder(folder);
      setNavigationPath(prev => [...prev, { nombre: folder.nombre, folder: folder }]);
    } else {
      setMessage(`⚠️ La carpeta "${folder.nombre}" está vacía o no existe aún.`);
    }
  };

  const navigateToPath = (index) => {
    const targetPath = navigationPath[index];
    setCurrentFolder(targetPath.folder);
    setNavigationPath(prev => prev.slice(0, index + 1));
  };

  const goBack = () => {
    if (navigationPath.length > 1) {
      const newPath = navigationPath.slice(0, -1);
      setNavigationPath(newPath);
      setCurrentFolder(newPath[newPath.length - 1].folder);
    }
  };

  const logout = () => {
    setIsLoggedIn(false);
    setWorkerInfo(null);
    setCurrentFolder(null);
    setNavigationPath([]);
    setLoginData({ dni: '', correo: '' });
    setMessage('');
  };

  const renderBreadcrumb = () => {
    return (
      <div className="breadcrumb">
        {navigationPath.map((pathItem, index) => (
          <React.Fragment key={index}>
            {index > 0 && <span className="breadcrumb-separator"> {'>'} </span>}
            <button 
              className="breadcrumb-item"
              onClick={() => navigateToPath(index)}
              disabled={index === navigationPath.length - 1}
            >
              {pathItem.nombre}
            </button>
          </React.Fragment>
        ))}
      </div>
    );
  };

  // Función para contar documentos recursivamente
  const countDocumentsRecursively = (folder) => {
    let count = folder.documentos ? folder.documentos.length : 0;
    if (folder.subcarpetas) {
      folder.subcarpetas.forEach(subfolder => {
        count += countDocumentsRecursively(subfolder);
      });
    }
    return count;
  };

  // Función para verificar si una carpeta tiene contenido real
  const isFolderWithContent = (folder) => {
    // Verificar si tiene documentos directos
    if (folder.documentos && folder.documentos.length > 0) {
      return true;
    }
    
    // Verificar si tiene subcarpetas con contenido
    if (folder.subcarpetas && folder.subcarpetas.length > 0) {
      return folder.subcarpetas.some(subfolder => isFolderWithContent(subfolder));
    }
    
    // Si no tiene ni documentos ni subcarpetas, o las subcarpetas están vacías
    return false;
  };

  const renderFolderView = () => {
    if (!currentFolder) {
      return (
        <div className="loading-message">
          <p>Cargando estructura de carpetas...</p>
        </div>
      );
    }

    const hasSubfolders = currentFolder.subcarpetas && currentFolder.subcarpetas.length > 0;
    const hasDocuments = currentFolder.documentos && currentFolder.documentos.length > 0;

    return (
      <div className="folder-view">
        <div className="folder-navigation">
          {renderBreadcrumb()}
          {navigationPath.length > 1 && (
            <button onClick={goBack} className="back-btn">
              ← Volver
            </button>
          )}
        </div>

        {hasSubfolders && (
          <div className="folders-section">
            <h3>📁 Carpetas ({currentFolder.subcarpetas.length})</h3>
            <div className="folders-grid">
              {currentFolder.subcarpetas.map((subfolder, index) => {
                const totalDocs = countDocumentsRecursively(subfolder);
                const hasContent = isFolderWithContent(subfolder);
                
                return (
                  <div 
                    key={`folder-${index}-${subfolder.nombre}`}
                    className={`folder-item ${!hasContent ? 'folder-empty' : ''}`}
                    onClick={() => navigateToFolder(subfolder)}
                    style={{ cursor: hasContent ? 'pointer' : 'not-allowed' }}
                  >
                    <div className="folder-icon">
                      {hasContent ? '📂' : '📁'}
                    </div>
                    <div className="folder-info">
                      <h4>{subfolder.nombre}</h4>
                      <p>
                        {totalDocs} documento{totalDocs !== 1 ? 's' : ''}
                        {subfolder.subcarpetas && subfolder.subcarpetas.length > 0 && 
                          ` • ${subfolder.subcarpetas.length} subcarpeta${subfolder.subcarpetas.length !== 1 ? 's' : ''}`
                        }
                      </p>
                      {!hasContent && (
                        <p style={{ color: '#888', fontSize: '12px', fontStyle: 'italic' }}>
                          Carpeta vacía
                        </p>
                      )}
                    </div>
                    <div className="folder-arrow">
                      {hasContent ? '→' : '∅'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {hasDocuments && (
          <div className="documents-section">
            <h3>📄 Documentos ({currentFolder.documentos.length})</h3>
            <div className="documents-list">
              {currentFolder.documentos.map((doc, index) => (
                <div key={`doc-${index}-${doc.id || index}`} className="document-item">
                  <div className="doc-info">
                    <h4>{doc.nombre}</h4>
                    <p>Fecha: {doc.fecha}</p>
                    <p>Tipo: <span className="doc-type">{doc.tipo}</span></p>
                    {doc.tamaño && <p>Tamaño: {doc.tamaño}</p>}
                  </div>
                  {doc.url && (
                    <a href={doc.url} target="_blank" rel="noopener noreferrer" className="view-btn">
                      Ver Documento
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!hasSubfolders && !hasDocuments && (
          <div className="empty-folder">
            <div className="empty-folder-icon">📂</div>
            <h3>Carpeta vacía</h3>
            <p>Esta carpeta no contiene documentos ni subcarpetas.</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="container">
      {loading && <LoadingSpinner message={loadingMessage} />}
      
      <h1>Sistema de Gestión Documental</h1>
      
      {/* Indicador de móvil para debug */}
      {isMobile && process.env.NODE_ENV === 'development' && (
        <div style={{ 
          background: '#e3f2fd', 
          padding: '8px', 
          marginBottom: '10px', 
          borderRadius: '4px',
          fontSize: '12px',
          color: '#1976d2'
        }}>
          📱 Modo móvil detectado - Optimizaciones activas
        </div>
      )}
      
      {!isLoggedIn ? (
        <>
          <div className="tabs">
            <button 
              className={`tab-button ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              Acceder a mis Documentos
            </button>
            <button 
              className={`tab-button ${activeTab === 'register' ? 'active' : ''}`}
              onClick={() => setActiveTab('register')}
            >
              Soy Nuevo
            </button>
          </div>

          {activeTab === 'dashboard' && (
            <div className="form-container">
              <h2>Acceso a Mis Documentos</h2>
              <p className="form-description">Introduce tus datos para acceder a tu documentación personal</p>
              <form onSubmit={handleLogin}>
                <input
                  type="text"
                  name="dni"
                  placeholder="DNI/NIE"
                  value={loginData.dni}
                  onChange={(e) => handleInputChange(e, 'login')}
                  required
                />
                <input
                  type="email"
                  name="correo"
                  placeholder="Correo electrónico"
                  value={loginData.correo}
                  onChange={(e) => handleInputChange(e, 'login')}
                  required
                />
                <button type="submit" disabled={loading}>
                  {loading ? 'Accediendo...' : 'Ver Mis Documentos'}
                </button>
              </form>
            </div>
          )}

          {activeTab === 'register' && (
            <div className="form-container">
              <h2>Registro de Nuevo Trabajador</h2>
              <p className="form-description">Completa todos los campos para registrarte en el sistema</p>
              <form onSubmit={handleRegister}>
                <div className="form-section">
                  <h3>Datos Personales</h3>
                  <input
                    type="text"
                    name="nombre"
                    placeholder="Nombre completo"
                    value={formData.nombre}
                    onChange={handleInputChange}
                    required
                  />
                  <input
                    type="text"
                    name="dni"
                    placeholder="DNI/NIE"
                    value={formData.dni}
                    onChange={handleInputChange}
                    required
                  />
                  <input
                    type="email"
                    name="correo"
                    placeholder="Correo electrónico"
                    value={formData.correo}
                    onChange={handleInputChange}
                    required
                  />
                  <input
                    type="tel"
                    name="telefono"
                    placeholder="Teléfono"
                    value={formData.telefono}
                    onChange={handleInputChange}
                    required
                  />
                </div>

                <div className="form-section">
                  <h3>Imagen DNI</h3>
                  <div className="file-upload-section">
                    <div className="file-input-group">
                      <label htmlFor="dniDelante" className="file-label">
                        <span className="file-label-text">📄 Parte delantera</span>
                        <span className="file-label-required">*</span>
                      </label>
                      <input
                        type="file"
                        id="dniDelante"
                        name="dniDelante"
                        accept="image/*"
                        capture={isMobile ? "environment" : undefined}
                        onChange={handleFileChange}
                        required
                        className="file-input"
                      />
                      {formData.dniDelante && (
                        <span className="file-selected">✓ {formData.dniDelante.name}</span>
                      )}
                    </div>
                    
                    <div className="file-input-group">
                      <label htmlFor="dniDetras" className="file-label">
                        <span className="file-label-text">📄 Parte trasera</span>
                        <span className="file-label-required">*</span>
                      </label>
                      <input
                        type="file"
                        id="dniDetras"
                        name="dniDetras"
                        accept="image/*"
                        capture={isMobile ? "environment" : undefined}
                        onChange={handleFileChange}
                        required
                        className="file-input"
                      />
                      {formData.dniDetras && (
                        <span className="file-selected">✓ {formData.dniDetras.name}</span>
                      )}
                    </div>
                  </div>
                  <p className="file-help-text">
                    Sube fotos claras de ambas caras de tu DNI/NIE. 
                    {isMobile ? ' Las imágenes se optimizarán automáticamente.' : ' Máximo 20MB por imagen.'}
                  </p>
                </div>

                <div className="form-section">
                  <h3>Dirección</h3>
                  <div className="address-row">
                    <input
                      type="text"
                      name="calle"
                      placeholder="Calle"
                      value={formData.calle}
                      onChange={handleInputChange}
                      required
                      className="address-street"
                    />
                    <input
                      type="text"
                      name="numero"
                      placeholder="Número"
                      value={formData.numero}
                      onChange={handleInputChange}
                      required
                      className="address-number"
                    />
                  </div>
                  <div className="address-row">
                    <input
                      type="text"
                      name="codigoPostal"
                      placeholder="Código Postal"
                      value={formData.codigoPostal}
                      onChange={handleInputChange}
                      required
                      className="address-postal"
                    />
                    <input
                      type="text"
                      name="localidad"
                      placeholder="Localidad"
                      value={formData.localidad}
                      onChange={handleInputChange}
                      required
                      className="address-city"
                    />
                  </div>
                  <input
                    type="text"
                    name="provincia"
                    placeholder="Provincia"
                    value={formData.provincia}
                    onChange={handleInputChange}
                    required
                  />
                </div>

                <div className="form-section">
                  <h3>Otros Datos</h3>
                  <select
                    name="empresa"
                    value={formData.empresa}
                    onChange={handleInputChange}
                    required
                  >
                    <option value="">Seleccionar empresa</option>
                    <option value="Pide Argoo">Pide Argoo</option>
                    <option value="La Traviata 1999">La Traviata 1999</option>
                  </select>
                  <select
                    name="talla"
                    value={formData.talla}
                    onChange={handleInputChange}
                    required
                  >
                    <option value="">Seleccionar talla</option>
                    <option value="XS">XS</option>
                    <option value="S">S</option>
                    <option value="M">M</option>
                    <option value="L">L</option>
                    <option value="XL">XL</option>
                    <option value="XXL">XXL</option>
                  </select>
                </div>

                <button type="submit" disabled={loading}>
                  {loading ? (isMobile ? 'Procesando...' : 'Registrando...') : 'Registrarme'}
                </button>
              </form>
            </div>
          )}
        </>
      ) : (
        <div className="dashboard">
          <div className="dashboard-header">
            <h2>Mis Documentos</h2>
            <div className="dashboard-info">
              {workerInfo && (
                <span className="worker-info">
                  {workerInfo.nombre} • {workerInfo.empresa} • {workerInfo.totalDocuments} documentos
                </span>
              )}
              <button onClick={logout} className="logout-btn">Cerrar Sesión</button>
            </div>
          </div>
          
          {renderFolderView()}
        </div>
      )}

      {message && (
        <div className={`toast-message ${message.includes('❌') ? 'error' : 'success'}`}>
          <div className="toast-content">
            {message}
            <button 
              className="toast-close" 
              onClick={() => setMessage('')}
              aria-label="Cerrar mensaje"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;