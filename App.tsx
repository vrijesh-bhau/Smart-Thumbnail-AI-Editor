
import React, { useState, useRef, useEffect } from 'react';
import ReactCrop, { Crop, PixelCrop, centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from './components/Button';
import { analyzeImage, editThumbnail, extractElements, enhanceThumbnail } from './services/geminiService';
import { ThumbnailState } from './types';

const STORAGE_KEY = 'smart_thumbnail_session';

const App: React.FC = () => {
  const [state, setState] = useState<ThumbnailState>({
    originalUrl: null,
    editedUrl: null,
    removedElementsUrl: null,
    replacementUrl: null,
    detectedElements: [],
    isAnalyzing: false,
    isEditing: false,
    error: null
  });

  const [customInstruction, setCustomInstruction] = useState('');
  const [selectedElements, setSelectedElements] = useState<string[]>([]);
  const [processingStatus, setProcessingStatus] = useState<string>('');
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [isCropping, setIsCropping] = useState(false);
  const [isSelectingArea, setIsSelectingArea] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [selection, setSelection] = useState<PixelCrop | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Load session from localStorage on mount
  useEffect(() => {
    const savedSession = localStorage.getItem(STORAGE_KEY);
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession);
        const { state: savedState, customInstruction: savedInstruction, selectedElements: savedElements, selection: savedSelection } = parsed;
        
        setState(prev => ({
          ...prev,
          ...savedState,
          isAnalyzing: false,
          isEditing: false,
          error: null
        }));
        setCustomInstruction(savedInstruction || '');
        setSelectedElements(savedElements || []);
        setSelection(savedSelection || null);
      } catch (err) {
        console.error("Failed to load saved session:", err);
      }
    }
  }, []);

  // Save session to localStorage on changes
  useEffect(() => {
    const sessionToSave = {
      state: {
        originalUrl: state.originalUrl,
        editedUrl: state.editedUrl,
        removedElementsUrl: state.removedElementsUrl,
        replacementUrl: state.replacementUrl,
        detectedElements: state.detectedElements,
      },
      customInstruction,
      selectedElements,
      selection
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionToSave));
    } catch (err) {
      // Handle quota exceeded or other storage errors
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        console.warn("Session too large to save to localStorage");
      } else {
        console.error("Failed to save session:", err);
      }
    }
  }, [state.originalUrl, state.editedUrl, state.removedElementsUrl, state.detectedElements, customInstruction, selectedElements, selection]);

  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget;
    const initialCrop = centerCrop(
      makeAspectCrop(
        {
          unit: '%',
          width: 90,
        },
        16 / 9,
        width,
        height
      ),
      width,
      height
    );
    setCrop(initialCrop);
  };

  const handleCropComplete = async () => {
    if (!completedCrop || !imgRef.current) return;

    const canvas = document.createElement('canvas');
    const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
    const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
    canvas.width = completedCrop.width;
    canvas.height = completedCrop.height;
    const ctx = canvas.getContext('2d');

    if (!ctx) return;

    ctx.drawImage(
      imgRef.current,
      completedCrop.x * scaleX,
      completedCrop.y * scaleY,
      completedCrop.width * scaleX,
      completedCrop.height * scaleY,
      0,
      0,
      completedCrop.width,
      completedCrop.height
    );

    const croppedBase64 = canvas.toDataURL('image/jpeg');
    const base64Data = croppedBase64.split(',')[1];

    setState(prev => ({
      ...prev,
      originalUrl: croppedBase64,
      editedUrl: null,
      removedElementsUrl: null,
      detectedElements: [],
      isAnalyzing: true
    }));
    setIsCropping(false);

    try {
      const elements = await analyzeImage(base64Data);
      setState(prev => ({
        ...prev,
        detectedElements: elements,
        isAnalyzing: false
      }));
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        error: err.message || "Failed to analyze image. Please try again.",
        isAnalyzing: false
      }));
    }
  };

  const processGreenToTransparent = (imgUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Image processing timed out")), 10000);
      const img = new Image();
      img.crossOrigin = "anonymous";
      
      img.onload = () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            resolve(imgUrl);
            return;
          }

          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            
            // Chroma key filtering for pure green (#00FF00)
            if (g > 100 && g > r * 1.2 && g > b * 1.2) {
              data[i + 3] = 0; // Set Alpha to 0
            }
          }

          ctx.putImageData(imageData, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) {
          console.error("Canvas processing error:", e);
          resolve(imgUrl); // Fallback to original if processing fails
        }
      };

      img.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Failed to load image for transparency processing"));
      };

      img.src = imgUrl;
    });
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target?.result as string;
      const base64Data = base64.split(',')[1];
      
      setState(prev => ({
        ...prev,
        originalUrl: base64,
        editedUrl: null,
        removedElementsUrl: null,
        replacementUrl: null,
        detectedElements: [],
        error: null,
        isAnalyzing: true
      }));

      try {
        const elements = await analyzeImage(base64Data);
        setState(prev => ({
          ...prev,
          detectedElements: elements,
          isAnalyzing: false
        }));
      } catch (err: any) {
        setState(prev => ({
          ...prev,
          error: err.message || "Failed to analyze image. Please try again.",
          isAnalyzing: false
        }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleReplacementUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result as string;
      setState(prev => ({ ...prev, replacementUrl: base64 }));
    };
    reader.readAsDataURL(file);
  };

  const toggleElementSelection = (elementName: string) => {
    setSelectedElements(prev => 
      prev.includes(elementName) 
        ? prev.filter(e => e !== elementName) 
        : [...prev, elementName]
    );
  };

  const handleApplyEdits = async () => {
    if (!state.originalUrl) return;

    const base64Data = state.originalUrl.split(',')[1];
    let instruction = "";

    if (selectedElements.length > 0) {
      instruction = `Remove the following elements: ${selectedElements.join(', ')}. `;
    }

    if (selection && imgRef.current) {
      const { width, height } = imgRef.current;
      // Convert to normalized coordinates (0-1000) for Gemini
      const ymin = Math.round((selection.y / height) * 1000);
      const xmin = Math.round((selection.x / width) * 1000);
      const ymax = Math.round(((selection.y + selection.height) / height) * 1000);
      const xmax = Math.round(((selection.x + selection.width) / width) * 1000);
      
      instruction += `Focus on the area defined by bounding box [${ymin}, ${xmin}, ${ymax}, ${xmax}]. `;
    }
    
    if (customInstruction.trim()) {
      instruction += customInstruction;
    } else if (selectedElements.length === 0 && !selection && !state.replacementUrl) {
      setState(prev => ({ ...prev, error: "Please select an element, area, or provide a replacement image." }));
      return;
    }

    if (state.replacementUrl) {
      instruction += " Replace the selected area or object with the provided replacement image. ";
    }

    setState(prev => ({ ...prev, isEditing: true, error: null }));
    setProcessingStatus('Connecting to Gemini AI...');

    try {
      setProcessingStatus('Generating edited thumbnail...');
      const replacementBase64 = state.replacementUrl?.split(',')[1];
      const editedBase64 = await editThumbnail(base64Data, instruction, replacementBase64);
      
      setProcessingStatus('Extracting removed elements layer...');
      let transparentLayer = null;
      try {
        const greenLayerBase64 = await extractElements(base64Data, selectedElements.length > 0 ? selectedElements.join(', ') : customInstruction);
        setProcessingStatus('Removing green screen...');
        transparentLayer = await processGreenToTransparent(greenLayerBase64);
      } catch (extractErr) {
        console.warn("Layer extraction failed, but continuing with main edit:", extractErr);
      }

      setState(prev => ({
        ...prev,
        editedUrl: editedBase64,
        removedElementsUrl: transparentLayer,
        isEditing: false
      }));
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err: any) {
      console.error("Apply Edits Error:", err);
      setState(prev => ({
        ...prev,
        error: err.message || "An error occurred while editing your thumbnail. The AI might be busy.",
        isEditing: false
      }));
    } finally {
      setProcessingStatus('');
    }
  };

  const handleAutoEnhance = async () => {
    if (!state.originalUrl) return;

    const base64Data = (state.editedUrl || state.originalUrl).split(',')[1];
    
    setIsEnhancing(true);
    setState(prev => ({ ...prev, isEditing: true, error: null }));
    setProcessingStatus('AI is enhancing colors and lighting...');

    try {
      const enhancedBase64 = await enhanceThumbnail(base64Data);
      
      setState(prev => ({
        ...prev,
        editedUrl: enhancedBase64,
        isEditing: false
      }));
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err: any) {
      console.error("Enhance Error:", err);
      setState(prev => ({
        ...prev,
        error: err.message || "Failed to enhance image. AI might be busy.",
        isEditing: false
      }));
    } finally {
      setIsEnhancing(false);
      setProcessingStatus('');
    }
  };

  const downloadImage = (url: string | null, filename: string) => {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-50 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg shadow-lg shadow-indigo-500/20">
              <i className="fas fa-magic text-white"></i>
            </div>
            <h1 className="text-xl font-bold tracking-tight">Smart Thumbnail <span className="text-indigo-500 italic">AI</span></h1>
          </div>
          <div className="hidden md:block">
            <p className="text-sm text-zinc-500">Professional YouTube Gaming Editor</p>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full p-4 md:p-8 space-y-8">
        {/* Error Banner */}
        <AnimatePresence>
          {state.error && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-red-500/10 border border-red-500/50 p-4 rounded-xl flex items-start gap-3"
            >
              <i className="fas fa-exclamation-triangle text-red-500 mt-1"></i>
              <div className="flex-1">
                <h4 className="text-sm font-bold text-red-500">Processing Error</h4>
                <p className="text-sm text-red-400/80 mt-1">{state.error}</p>
              </div>
              <button 
                onClick={() => setState(p => ({ ...p, error: null }))}
                className="text-red-500/50 hover:text-red-500 transition-colors"
              >
                <i className="fas fa-times"></i>
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Success Banner */}
        <AnimatePresence>
          {showSuccess && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-emerald-500/10 border border-emerald-500/50 p-4 rounded-xl flex items-start gap-3"
            >
              <i className="fas fa-check-circle text-emerald-500 mt-1"></i>
              <div className="flex-1">
                <h4 className="text-sm font-bold text-emerald-500">Edit Complete</h4>
                <p className="text-sm text-emerald-400/80 mt-1">Your thumbnail has been successfully processed by Gemini AI.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Upload Section */}
        {!state.originalUrl ? (
          <div 
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-zinc-800 rounded-2xl h-[400px] flex flex-col items-center justify-center gap-4 cursor-pointer hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-all group"
          >
            <div className="bg-zinc-900 p-6 rounded-full group-hover:bg-indigo-500/10 transition-colors">
              <i className="fas fa-cloud-upload-alt text-4xl text-zinc-600 group-hover:text-indigo-500"></i>
            </div>
            <div className="text-center">
              <p className="text-xl font-semibold">Drop your thumbnail here</p>
              <p className="text-zinc-500 mt-1">Accepts JPG, PNG, WEBP (16:9 recommended)</p>
            </div>
            <input 
              type="file" 
              className="hidden" 
              ref={fileInputRef} 
              accept="image/*" 
              onChange={handleFileUpload} 
            />
            <Button variant="secondary" className="mt-2">Browse Files</Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left Col: Workspace */}
            <div className="lg:col-span-2 space-y-6">
              <div className="relative aspect-video bg-zinc-900 rounded-xl overflow-hidden border border-zinc-800 shadow-2xl">
                <AnimatePresence>
                  {state.isEditing && (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0 z-10 bg-black/70 flex flex-col items-center justify-center backdrop-blur-sm transition-all"
                    >
                      <motion.div 
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                        className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full"
                      ></motion.div>
                      <motion.p 
                        animate={{ opacity: [0.5, 1, 0.5] }}
                        transition={{ repeat: Infinity, duration: 2 }}
                        className="mt-6 text-indigo-400 font-medium tracking-wide"
                      >
                        {processingStatus}
                      </motion.p>
                      <p className="mt-2 text-zinc-500 text-xs">This may take up to 30 seconds</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence>
                  {isCropping && (
                    <motion.div 
                      initial={{ opacity: 0, scale: 1.1 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      className="absolute inset-0 z-20 bg-black/90 flex flex-col items-center justify-center p-4"
                    >
                      <div className="max-h-[80%] w-full flex justify-center">
                        <ReactCrop
                          crop={crop}
                          onChange={(c) => setCrop(c)}
                          onComplete={(c) => setCompletedCrop(c)}
                          aspect={16 / 9}
                          className="max-h-full"
                        >
                          <img
                            ref={imgRef}
                            alt="Crop"
                            src={state.originalUrl || ''}
                            onLoad={onImageLoad}
                            className="max-h-[60vh] object-contain"
                          />
                        </ReactCrop>
                      </div>
                      <div className="mt-6 flex gap-4">
                        <Button onClick={handleCropComplete}>Apply Crop</Button>
                        <Button variant="ghost" onClick={() => setIsCropping(false)}>Cancel</Button>
                      </div>
                      <p className="mt-4 text-xs text-zinc-500 italic">Aspect ratio locked to 16:9 for YouTube thumbnails</p>
                    </motion.div>
                  )}
                </AnimatePresence>
                
                <img 
                  ref={imgRef}
                  src={state.editedUrl || state.originalUrl || ''} 
                  alt="Thumbnail Workspace" 
                  className="w-full h-full object-contain"
                />

                {isSelectingArea && (
                  <div className="absolute inset-0 z-30 bg-black/20">
                    <ReactCrop
                      crop={crop}
                      onChange={(c) => setCrop(c)}
                      onComplete={(c) => setSelection(c)}
                      className="w-full h-full"
                    >
                      <div className="w-full h-full" />
                    </ReactCrop>
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-indigo-600 px-4 py-2 rounded-full text-xs font-bold shadow-xl border border-white/20 flex items-center gap-2">
                      <i className="fas fa-mouse-pointer"></i>
                      DRAG TO SELECT AREA
                      <button 
                        onClick={() => {
                          setIsSelectingArea(false);
                          setSelection(null);
                        }}
                        className="ml-2 hover:text-red-300"
                      >
                        <i className="fas fa-times"></i>
                      </button>
                    </div>
                  </div>
                )}

                <div className="absolute bottom-4 right-4 flex gap-2">
                  {!isCropping && !isSelectingArea && (
                    <>
                      <motion.button 
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => {
                          setIsSelectingArea(true);
                          setCrop({ unit: '%', width: 30, height: 30, x: 35, y: 35 });
                        }}
                        className={`bg-black/60 hover:bg-indigo-600/80 backdrop-blur px-3 py-1.5 rounded text-[10px] font-bold text-white border border-white/10 transition-all flex items-center gap-2 ${selection ? 'border-indigo-500 bg-indigo-600/40' : ''}`}
                      >
                        <i className="fas fa-vector-square"></i> {selection ? 'AREA SELECTED' : 'SELECT AREA'}
                      </motion.button>
                      <motion.button 
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => setIsCropping(true)}
                        className="bg-black/60 hover:bg-indigo-600/80 backdrop-blur px-3 py-1.5 rounded text-[10px] font-bold text-white border border-white/10 transition-all flex items-center gap-2"
                      >
                        <i className="fas fa-crop-alt"></i> CROP & RESIZE
                      </motion.button>
                    </>
                  )}
                  <span className="bg-black/60 backdrop-blur px-2 py-1 rounded text-[10px] font-mono text-zinc-400 border border-white/5">16:9 RATIO</span>
                  <AnimatePresence>
                    {state.editedUrl && (
                      <motion.span 
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="bg-indigo-600/90 backdrop-blur px-2 py-1 rounded text-[10px] font-bold text-white shadow-lg"
                      >
                        AI ENHANCED
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Controls */}
              <div className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-xl space-y-6">
                <div>
                  <label className="text-sm font-semibold text-zinc-400 mb-4 block uppercase tracking-wider">Auto Detected Elements</label>
                  {state.isAnalyzing ? (
                    <div className="flex items-center gap-3 py-2">
                      <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                      <span className="text-sm text-zinc-500">AI is scanning your thumbnail...</span>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <AnimatePresence mode="popLayout">
                        {state.detectedElements.length > 0 ? (
                          state.detectedElements.map((el, idx) => (
                            <motion.button
                              key={`${el.name}-${idx}`}
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              layout
                              onClick={() => toggleElementSelection(el.name)}
                              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-2 border ${
                                selectedElements.includes(el.name)
                                  ? "bg-red-500/10 border-red-500 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.1)]"
                                  : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500"
                              }`}
                            >
                              <i className={`fas ${selectedElements.includes(el.name) ? 'fa-minus-circle' : 'fa-plus-circle'}`}></i>
                              {el.name} <span className="opacity-40 font-normal uppercase text-[9px] tracking-tight">{el.type}</span>
                            </motion.button>
                          ))
                        ) : (
                          <p className="text-sm text-zinc-500 italic">No elements detected yet.</p>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-sm font-semibold text-zinc-400 mb-2 block uppercase tracking-wider">Custom Instructions</label>
                  <textarea 
                    value={customInstruction}
                    onChange={(e) => setCustomInstruction(e.target.value)}
                    placeholder="Describe what you want to remove or replace (e.g., 'Replace the red character with the uploaded person')"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all min-h-[100px] placeholder:text-zinc-700 resize-none"
                  />
                </div>

                <div>
                  <label className="text-sm font-semibold text-zinc-400 mb-4 block uppercase tracking-wider">Replacement Image (Optional)</label>
                  <div className="flex items-center gap-4">
                    {!state.replacementUrl ? (
                      <button 
                        onClick={() => replacementInputRef.current?.click()}
                        className="flex-1 border-2 border-dashed border-zinc-800 rounded-xl p-4 flex flex-col items-center justify-center gap-2 hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-all group"
                      >
                        <i className="fas fa-plus-circle text-zinc-600 group-hover:text-indigo-500"></i>
                        <span className="text-xs text-zinc-500">Upload replacement object/person</span>
                      </button>
                    ) : (
                      <div className="relative w-32 h-32 rounded-xl overflow-hidden border border-indigo-500 shadow-lg shadow-indigo-500/20 group">
                        <img src={state.replacementUrl} className="w-full h-full object-cover" alt="Replacement" />
                        <button 
                          onClick={() => setState(prev => ({ ...prev, replacementUrl: null }))}
                          className="absolute top-1 right-1 bg-red-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <i className="fas fa-times"></i>
                        </button>
                      </div>
                    )}
                    <input 
                      type="file" 
                      className="hidden" 
                      ref={replacementInputRef} 
                      accept="image/*" 
                      onChange={handleReplacementUpload} 
                    />
                    {state.replacementUrl && (
                      <div className="flex-1 text-xs text-zinc-500">
                        <p className="font-semibold text-zinc-400">Image loaded!</p>
                        <p className="mt-1 italic">Use "Select Area" or tags to tell AI where to put this.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 pt-2">
                  <Button 
                    onClick={handleApplyEdits}
                    isLoading={state.isEditing && !isEnhancing}
                    disabled={state.isAnalyzing || state.isEditing || (selectedElements.length === 0 && !customInstruction && !selection)}
                    className="flex-1 md:flex-none px-10 h-11"
                  >
                    Apply Smart Edits
                  </Button>
                  <Button 
                    variant="outline"
                    onClick={handleAutoEnhance}
                    isLoading={isEnhancing}
                    disabled={state.isAnalyzing || state.isEditing}
                    className="flex-1 md:flex-none px-8 h-11 border-indigo-500/30 hover:bg-indigo-500/10 text-indigo-400"
                  >
                    <i className="fas fa-wand-magic-sparkles"></i> Auto-Enhance
                  </Button>
                  <Button 
                    variant="ghost" 
                    onClick={() => {
                      setState({
                        originalUrl: null,
                        editedUrl: null,
                        removedElementsUrl: null,
                        replacementUrl: null,
                        detectedElements: [],
                        isAnalyzing: false,
                        isEditing: false,
                        error: null
                      });
                      setSelectedElements([]);
                      setCustomInstruction('');
                      setSelection(null);
                      localStorage.removeItem(STORAGE_KEY);
                    }}
                    className="h-11"
                  >
                    Reset All
                  </Button>
                </div>
              </div>
            </div>

            {/* Right Col: Sidebar / Results */}
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="space-y-6"
            >
              <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl space-y-4 shadow-xl">
                <h3 className="font-semibold text-lg flex items-center gap-2">
                  <i className="fas fa-download text-indigo-500"></i> Export Assets
                </h3>
                <div className="space-y-3">
                  <Button 
                    variant="outline" 
                    className="w-full justify-start text-sm border-zinc-800 bg-zinc-900/50"
                    onClick={() => downloadImage(state.originalUrl, "original_thumbnail.png")}
                  >
                    <i className="fas fa-image w-5 text-zinc-500"></i> Download Original
                  </Button>
                  <Button 
                    variant="primary" 
                    className="w-full justify-start text-sm"
                    disabled={!state.editedUrl}
                    onClick={() => downloadImage(state.editedUrl, "smart_thumbnail_edited.png")}
                  >
                    <i className="fas fa-check-circle w-5"></i> Download Edited (1080p)
                  </Button>
                  <Button 
                    variant="outline" 
                    className="w-full justify-start text-sm border-zinc-800 bg-zinc-900/50"
                    disabled={!state.removedElementsUrl}
                    onClick={() => downloadImage(state.removedElementsUrl, "removed_elements_layer.png")}
                  >
                    <i className="fas fa-scissors w-5 text-indigo-400"></i> {state.removedElementsUrl ? "Download Removed Layer" : "Layer Extraction Unavailable"}
                  </Button>
                  <p className="text-[10px] text-zinc-500 mt-2 px-1 leading-relaxed italic">
                    * Final export is upscaled to 1920x1080 with AI sharpening and texture preservation.
                  </p>
                </div>
              </div>

              <AnimatePresence>
                {state.removedElementsUrl && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl space-y-3 overflow-hidden"
                  >
                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Removed Element Preview</p>
                    <div className="aspect-video bg-zinc-950 rounded-lg overflow-hidden border border-zinc-800/50 bg-[url('https://www.transparenttextures.com/patterns/checkerboard.png')] bg-center shadow-inner">
                      <img src={state.removedElementsUrl} className="w-full h-full object-contain" alt="Removed elements" />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="bg-zinc-900/40 border border-zinc-800 p-6 rounded-xl">
                <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
                  <i className="fas fa-info-circle text-zinc-500"></i> EDITOR TIPS
                </h3>
                <ul className="text-xs text-zinc-500 space-y-4">
                  <li className="flex gap-3">
                    <i className="fas fa-lightbulb text-indigo-500 mt-0.5 flex-shrink-0"></i>
                    <span>Click the detected tags to quickly queue items for removal.</span>
                  </li>
                  <li className="flex gap-3">
                    <i className="fas fa-layer-group text-indigo-500 mt-0.5 flex-shrink-0"></i>
                    <span>The "Removed Layer" is a transparent PNG containing just the objects you took out, perfect for re-compositing in Photoshop.</span>
                  </li>
                  <li className="flex gap-3">
                    <i className="fas fa-wand-sparkles text-indigo-500 mt-0.5 flex-shrink-0"></i>
                    <span>The model automatically enhances cinematic lighting in the edited areas.</span>
                  </li>
                </ul>
              </div>
            </motion.div>
          </div>
        )}
      </main>

      <footer className="border-t border-zinc-900 p-6 text-center text-zinc-600 text-[10px] uppercase tracking-widest">
        <p>&copy; 2024 Smart Thumbnail AI. Powered by Google Gemini AI & Nano Banana.</p>
      </footer>
    </div>
  );
};

export default App;
