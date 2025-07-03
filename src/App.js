import React, { useState, useEffect } from 'react';
import './App.css';

// Configuración de API para desarrollo y producción
const API_BASE = process.env.NODE_ENV === 'production' 
  ? '/.netlify/functions' 
  : 'http://localhost:8888/.netlify/functions';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [loading, setLoading] = useState(false);
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
  const [, setFolderStructure] = useState(null);
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

  const handleInputChange = (e, form = 'register') => {
    const { name, value } = e.target;
    if (form === 'register') {
      setFormData(prev => ({ ...prev, [name]: value }));
    } else {
      setLoginData(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleFileChange = (e) => {
    const { name, files } = e.target;
    const file = files[0];
    
    if (file) {
      // Validar tamaño (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        setMessage('❌ La imagen es demasiado grande. Máximo 5MB.');
        e.target.value = ''; // Limpiar el input
        return;
      }
      
      // Validar tipo
      if (!file.type.startsWith('image/')) {
        setMessage('❌ Solo se permiten archivos de imagen.');
        e.target.value = ''; // Limpiar el input
        return;
      }
      
      setFormData(prev => ({ ...prev, [name]: file }));
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
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

      console.log('Enviando formulario a:', `${API_BASE}/register-worker`);

      const response = await fetch(`${API_BASE}/register-worker`, {
        method: 'POST',
        body: formDataToSend
        // NO establecer Content-Type header cuando uses FormData
      });

      const result = await response.json();
      console.log('Respuesta del servidor:', result);

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
      } else {
        setMessage(`❌ Error: ${result.error || 'Error desconocido'}`);
      }
    } catch (error) {
      console.error('Error en registro:', error);
      setMessage('❌ Error de conexión. Por favor, inténtalo de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      console.log('Iniciando login con:', loginData);
      
      const response = await fetch(`${API_BASE}/worker-documents`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(loginData)
      });

      const result = await response.json();
      console.log('Respuesta del servidor:', result);

      if (response.ok) {
        setFolderStructure(result.folderStructure);
        setWorkerInfo(result.workerInfo);
        setCurrentFolder(result.folderStructure);
        setNavigationPath([{ nombre: result.folderStructure.nombre, folder: result.folderStructure }]);
        setIsLoggedIn(true);
        setMessage('✅ Acceso exitoso');
      } else {
        setMessage(`❌ ${result.error || 'Error al acceder'}`);
      }
    } catch (error) {
      console.error('Error en login:', error);
      setMessage('❌ Error de conexión. Por favor, inténtalo de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const navigateToFolder = (folder) => {
    setCurrentFolder(folder);
    setNavigationPath(prev => [...prev, { nombre: folder.nombre, folder: folder }]);
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
    setFolderStructure(null);
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

  const renderFolderView = () => {
    if (!currentFolder) return null;

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
            <h3>📁 Carpetas</h3>
            <div className="folders-grid">
              {currentFolder.subcarpetas.map((subfolder, index) => (
                <div 
                  key={index} 
                  className="folder-item"
                  onClick={() => navigateToFolder(subfolder)}
                >
                  <div className="folder-icon">📁</div>
                  <div className="folder-info">
                    <h4>{subfolder.nombre}</h4>
                    <p>
                      {subfolder.documentos.length} documento{subfolder.documentos.length !== 1 ? 's' : ''}
                      {subfolder.subcarpetas.length > 0 && 
                        ` • ${subfolder.subcarpetas.length} subcarpeta${subfolder.subcarpetas.length !== 1 ? 's' : ''}`
                      }
                    </p>
                  </div>
                  <div className="folder-arrow">→</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasDocuments && (
          <div className="documents-section">
            <h3>📄 Documentos</h3>
            <div className="documents-list">
              {currentFolder.documentos.map((doc, index) => (
                <div key={index} className="document-item">
                  <div className="doc-info">
                    <h4>{doc.nombre}</h4>
                    <p>Fecha: {doc.fecha}</p>
                    <p>Tipo: <span className="doc-type">{doc.tipo}</span></p>
                    <p>Estado: <span className={`status ${doc.estado.toLowerCase()}`}>{doc.estado}</span></p>
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
      <h1>Sistema de Gestión Documental</h1>
      
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
                    Sube fotos claras de ambas caras de tu DNI/NIE. Máximo 5MB por imagen.
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
                  {loading ? 'Registrando...' : 'Registrarme'}
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