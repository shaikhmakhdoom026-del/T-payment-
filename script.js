// ETM System - Complete Implementation
class ETMSystem {
    constructor() {
        // Your NFC Keys
        this.nfcKeys = {
            keyA: "C74EA9135DF2",
            keyB: "8BF126D49C70",
            masterKey: "E3916A5FC82D"
        };
        
        this.magicBytes = "ETM1attachedthis";
        this.accessBits = "787788"; // 0x78 0x77 0x88
        
        // Transaction data
        this.selectedFare = 0;
        this.todayTotal = 0;
        this.weekTotal = 0;
        this.todayTx = 0;
        this.weekTx = 0;
        
        // System state
        this.serialPort = null;
        this.isConnected = false;
        this.isProcessing = false;
        this.currentCardUID = "";
        
        // Week data
        this.weekData = {};
        this.initializeWeekData();
        
        // Initialize
        this.init();
    }
    
    init() {
        // Load saved data
        this.loadLocalData();
        
        // Update UI
        this.updateUI();
        
        // Update time
        this.updateSystemTime();
        setInterval(() => this.updateSystemTime(), 1000);
        
        // Check Web Serial API support
        if (!('serial' in navigator)) {
            this.logMessage("Web Serial API not supported. Use Chrome/Edge 89+", "error");
            document.getElementById('connectBtn').disabled = true;
        }
        
        // Event listeners
        this.setupEventListeners();
        
        this.logMessage("System initialized", "success");
    }
    
    initializeWeekData() {
        const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        days.forEach(day => {
            this.weekData[day] = {
                amount: 0,
                transactions: 0,
                date: this.getDateForDay(day)
            };
        });
    }
    
    getDateForDay(day) {
        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const today = new Date();
        const currentDay = today.getDay();
        const targetDay = days.indexOf(day);
        const diff = targetDay - currentDay;
        const date = new Date(today);
        date.setDate(today.getDate() + diff);
        return date.toLocaleDateString();
    }
    
    setupEventListeners() {
        // Connect button
        document.getElementById('connectBtn').addEventListener('click', () => this.connectESP32());
        
        // Cancel button
        document.getElementById('cancelBtn').addEventListener('click', () => this.cancelTransaction());
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'k') this.showKeys();
            if (e.ctrlKey && e.key === 'e') this.exportData();
            if (e.ctrlKey && e.key === 'r') this.resetToday();
        });
    }
    
    // === FARE SELECTION ===
    selectFare(amount) {
        if (this.isProcessing) {
            alert("Transaction in progress. Please wait.");
            return;
        }
        
        this.selectedFare = amount;
        
        // Update selected display
        document.getElementById('selectedFareDisplay').innerHTML = `
            <i class="fas fa-check-circle"></i>
            <span>Selected: ₹${amount}</span>
        `;
        
        // Highlight selected button
        document.querySelectorAll('.fare-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        event.target.classList.add('active');
        
        // Update NFC status
        document.getElementById('nfcStatusText').textContent = `Ready - ₹${amount}`;
        
        this.logMessage(`Fare selected: ₹${amount}`, "info");
        
        if (!this.isConnected) {
            this.logMessage("Please connect to ESP32 first", "warning");
        }
    }
    
    // === ESP32 CONNECTION ===
    async connectESP32() {
        try {
            // Request serial port
            this.serialPort = await navigator.serial.requestPort();
            
            // Open with baud rate 115200 (common for ESP32)
            await this.serialPort.open({ baudRate: 115200 });
            
            this.isConnected = true;
            
            // Update UI
            document.getElementById('connectBtn').innerHTML = '<i class="fas fa-plug"></i> Connected';
            document.getElementById('connectBtn').classList.remove('btn-primary');
            document.getElementById('connectBtn').classList.add('btn-success');
            document.getElementById('connectBtn').disabled = true;
            
            document.getElementById('statusText').textContent = "Connected";
            document.querySelector('.status-dot').classList.add('connected');
            
            this.logMessage("Connected to ESP32 successfully", "success");
            
            // Start reading data
            this.readESP32Data();
            
            // Send initialization commands
            setTimeout(() => {
                this.sendToESP32("INIT");
                this.sendToESP32(`KEYS:${this.nfcKeys.keyA}:${this.nfcKeys.keyB}:${this.nfcKeys.masterKey}`);
                this.sendToESP32(`MAGIC:${this.magicBytes}`);
            }, 1000);
            
        } catch (error) {
            this.logMessage(`Connection failed: ${error.message}`, "error");
            alert("Failed to connect to ESP32. Make sure it's connected via USB.");
        }
    }
    
    async sendToESP32(command) {
        if (!this.serialPort || !this.isConnected) {
            this.logMessage("Not connected to ESP32", "error");
            return;
        }
        
        try {
            const writer = this.serialPort.writable.getWriter();
            const encoder = new TextEncoder();
            await writer.write(encoder.encode(command + '\n'));
            writer.releaseLock();
            this.logMessage(`Sent: ${command}`, "info");
        } catch (error) {
            this.logMessage(`Send error: ${error.message}`, "error");
        }
    }
    
    async readESP32Data() {
        try {
            while (this.serialPort.readable && this.isConnected) {
                const reader = this.serialPort.readable.getReader();
                
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        
                        const text = new TextDecoder().decode(value);
                        this.processESP32Data(text);
                    }
                } finally {
                    reader.releaseLock();
                }
            }
        } catch (error) {
            this.logMessage(`Read error: ${error.message}`, "error");
        }
    }
    
    processESP32Data(data) {
        const lines = data.split('\n');
        
        lines.forEach(line => {
            if (line.trim() === '') return;
            
            this.logMessage(`ESP32: ${line}`, "info");
            
            if (line.startsWith('NFC_UID:')) {
                const uid = line.substring(8);
                this.handleCardDetected(uid);
            }
            else if (line.startsWith('AUTH_SUCCESS')) {
                this.processPayment();
            }
            else if (line.startsWith('WRITE_SUCCESS')) {
                this.completeTransaction();
            }
            else if (line.startsWith('ERROR:')) {
                this.logMessage(`ESP32 Error: ${line.substring(6)}`, "error");
                this.isProcessing = false;
            }
        });
    }
    
    // === NFC CARD PROCESSING ===
    handleCardDetected(uid) {
        if (this.selectedFare === 0) {
            this.logMessage("Please select fare first", "error");
            return;
        }
        
        this.currentCardUID = uid;
        this.isProcessing = true;
        
        // Update UI
        document.getElementById('lastCardUID').textContent = uid;
        document.getElementById('nfcStatusText').textContent = "Processing...";
        document.getElementById('cancelBtn').disabled = false;
        
        this.logMessage(`Card detected: ${uid}`, "info");
        
        // Send authentication command
        this.sendToESP32(`AUTH:${uid}:${this.selectedFare}`);
    }
    
    async processPayment() {
        // Simulate payment processing
        this.logMessage("Authenticating card...", "info");
        
        // In real implementation, this would:
        // 1. Read current balance from card
        // 2. Check if balance >= selectedFare
        // 3. Deduct amount
        // 4. Write new balance
        
        // For demo, simulate with delay
        setTimeout(() => {
            this.sendToESP32(`DEDUCT:${this.selectedFare}`);
        }, 2000);
    }
    
    completeTransaction() {
        // Update totals
        this.todayTotal += this.selectedFare;
        this.weekTotal += this.selectedFare;
        this.todayTx++;
        this.weekTx++;
        
        // Update current day
        const today = new Date().toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
        if (this.weekData[today]) {
            this.weekData[today].amount += this.selectedFare;
            this.weekData[today].transactions++;
        }
        
        // Update UI
        this.updateUI();
        
        // Save data
        this.saveLocalData();
        
        // Reset for next transaction
        this.selectedFare = 0;
        this.isProcessing = false;
        this.currentCardUID = "";
        
        // Update displays
        document.getElementById('selectedFareDisplay').innerHTML = `
            <i class="fas fa-check-circle"></i>
            <span>No fare selected</span>
        `;
        
        document.getElementById('nfcStatusText').textContent = "Ready";
        document.getElementById('cancelBtn').disabled = true;
        
        // Clear selected button
        document.querySelectorAll('.fare-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        // Send print command
        this.sendToESP32("PRINT");
        
        // Show success
        this.logMessage(`Transaction successful: ₹${this.selectedFare}`, "success");
        
        // Play success sound (if browser allows)
        this.playSound('success');
    }
    
    cancelTransaction() {
        this.selectedFare = 0;
        this.isProcessing = false;
        this.currentCardUID = "";
        
        // Reset UI
        document.getElementById('selectedFareDisplay').innerHTML = `
            <i class="fas fa-times-circle"></i>
            <span>Transaction cancelled</span>
        `;
        
        document.getElementById('nfcStatusText').textContent = "Ready";
        document.getElementById('cancelBtn').disabled = true;
        
        document.querySelectorAll('.fare-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        this.logMessage("Transaction cancelled", "warning");
    }
    
    // === DATA MANAGEMENT ===
    updateUI() {
        document.getElementById('todayAmount').textContent = `₹${this.todayTotal}`;
        document.getElementById('weekAmount').textContent = `₹${this.weekTotal}`;
        document.getElementById('todayTx').textContent = `${this.todayTx} transactions`;
        document.getElementById('weekTx').textContent = `${this.weekTx} total`;
    }
    
    updateSystemTime() {
        const now = new Date();
        const timeString = now.toLocaleTimeString();
        document.getElementById('systemTime').textContent = timeString;
    }
    
    saveLocalData() {
        const data = {
            todayTotal: this.todayTotal,
            weekTotal: this.weekTotal,
            todayTx: this.todayTx,
            weekTx: this.weekTx,
            weekData: this.weekData,
            lastUpdated: new Date().toISOString()
        };
        localStorage.setItem('etm_data', JSON.stringify(data));
    }
    
    loadLocalData() {
        const saved = localStorage.getItem('etm_data');
        if (saved) {
            const data = JSON.parse(saved);
            this.todayTotal = data.todayTotal || 0;
            this.weekTotal = data.weekTotal || 0;
            this.todayTx = data.todayTx || 0;
            this.weekTx = data.weekTx || 0;
            this.weekData = data.weekData || this.weekData;
            this.updateUI();
            this.logMessage("Data loaded from local storage", "info");
        }
    }
    
    // === LOGGING ===
    logMessage(message, type = "info") {
        const logContainer = document.getElementById('transactionLog');
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        
        const time = new Date().toLocaleTimeString();
        entry.innerHTML = `
            <span class="time">[${time}]</span>
            <span class="message">${message}</span>
        `;
        
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
        
        // Keep last 50 entries
        while (logContainer.children.length > 50) {
            logContainer.removeChild(logContainer.firstChild);
        }
    }
    
    // === MODAL FUNCTIONS ===
    showWeekModal() {
        const modal = document.getElementById('weekModal');
        const tbody = document.getElementById('weekDetails');
        
        let html = '';
        const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        
        days.forEach(day => {
            const data = this.weekData[day] || { amount: 0, transactions: 0, date: '' };
            const avg = data.transactions > 0 ? (data.amount / data.transactions).toFixed(2) : 0;
            
            html += `
                <tr>
                    <td>${day.charAt(0).toUpperCase() + day.slice(1)}</td>
                    <td>₹${data.amount}</td>
                    <td>${data.transactions}</td>
                    <td>₹${avg}</td>
                </tr>
            `;
        });
        
        tbody.innerHTML = html;
        modal.style.display = 'flex';
    }
    
    closeWeekModal() {
        document.getElementById('weekModal').style.display = 'none';
    }
    
    showAdminPanel() {
        document.getElementById('adminModal').style.display = 'flex';
    }
    
    closeAdminModal() {
        document.getElementById('adminModal').style.display = 'none';
    }
    
    showKeys() {
        document.getElementById('keysModal').style.display = 'flex';
    }
    
    closeKeysModal() {
        document.getElementById('keysModal').style.display = 'none';
    }
    
    // === ADMIN FUNCTIONS ===
    resetToday() {
        if (confirm("Reset today's data? This cannot be undone.")) {
            this.todayTotal = 0;
            this.todayTx = 0;
            this.updateUI();
            this.saveLocalData();
            this.logMessage("Today's data reset", "warning");
            this.closeAdminModal();
        }
    }
    
    exportData() {
        const data = {
            todayTotal: this.todayTotal,
            weekTotal: this.weekTotal,
            todayTx: this.todayTx,
            weekTx: this.weekTx,
            weekData: this.weekData,
            exportDate: new Date().toISOString()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `etm_data_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        
        this.logMessage("Data exported", "success");
    }
    
    clearLogs() {
        const logContainer = document.getElementById('transactionLog');
        logContainer.innerHTML = '<div class="log-entry"><span class="time">[00:00:00]</span><span class="message">Logs cleared</span></div>';
        this.logMessage("Logs cleared", "warning");
    }
    
    // === UTILITY FUNCTIONS ===
    playSound(type) {
        // Create audio context for beep sounds
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            if (type === 'success') {
                oscillator.frequency.value = 800;
                oscillator.type = 'sine';
            } else {
                oscillator.frequency.value = 400;
                oscillator.type = 'sawtooth';
            }
            
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.5);
        } catch (e) {
            console.log("Audio not supported");
        }
    }
}

// Initialize system when page loads
window.addEventListener('DOMContentLoaded', () => {
    window.etmSystem = new ETMSystem();
    
    // Make functions available globally
    window.selectFare = (amount) => window.etmSystem.selectFare(amount);
    window.connectESP32 = () => window.etmSystem.connectESP32();
    window.cancelTransaction = () => window.etmSystem.cancelTransaction();
    window.showWeekModal = () => window.etmSystem.showWeekModal();
    window.closeWeekModal = () => window.etmSystem.closeWeekModal();
    window.showAdminPanel = () => window.etmSystem.showAdminPanel();
    window.closeAdminModal = () => window.etmSystem.closeAdminModal();
    window.showKeys = () => window.etmSystem.showKeys();
    window.closeKeysModal = () => window.etmSystem.closeKeysModal();
    window.resetToday = () => window.etmSystem.resetToday();
    window.exportData = () => window.etmSystem.exportData();
    window.clearLogs = () => window.etmSystem.clearLogs();
    
    // Add today details function
    window.showTodayDetails = () => {
        alert(`Today's Summary:\nTotal: ₹${window.etmSystem.todayTotal}\nTransactions: ${window.etmSystem.todayTx}\nAverage: ₹${(window.etmSystem.todayTotal / window.etmSystem.todayTx || 0).toFixed(2)}`);
    };
});