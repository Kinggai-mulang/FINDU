import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

class ErrorBoundary extends React.Component<React.PropsWithChildren, {error:string|null}> {
  state:{error:string|null}={error:null};
  static getDerivedStateFromError(error:Error) {return {error:error.message};}
  render() {return this.state.error?<div style={{padding:48,color:'#dde5f2',background:'#10141c',minHeight:'100vh'}}><h1>工作台暂时无法显示</h1><p>{this.state.error}</p><button onClick={()=>location.reload()}>重新载入</button></div>:this.props.children;}
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>);
