import HandTracker from './components/HandTracker';
import './App.css';

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">
          <span className="title-icon">✋</span>
          Hand Gesture Recognition
          <span className="title-sub">Real-time tracking</span>
        </h1>
        <p className="app-desc">
          Spread thumbs & index fingers on both hands to open the viewfinder · Powered by MediaPipe
        </p>
      </header>

      <main className="app-main">
        <HandTracker />
      </main>

      <footer className="app-footer">
        <p>React + Vite + MediaPipe Hands | Real-time two-hand tracking</p>
      </footer>
    </div>
  );
}

export default App;