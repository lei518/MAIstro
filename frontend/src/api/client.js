import axios from 'axios';

const explicitBase = import.meta.env.VITE_API_BASE;
export const API_BASE = explicitBase || (window.location.hostname === 'localhost' ? 'http://localhost:8000' : `http://${window.location.hostname}:8000`);
export const WS_BASE = API_BASE.replace(/^http/, 'ws');

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 240000,
});

export function openPracticeSocket(sessionId) {
  return new WebSocket(`${WS_BASE}/ws/practice/${sessionId}`);
}

export async function uploadSheet(file) {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/upload-sheet', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function startSession(payload) {
  const { data } = await api.post('/session/start', payload);
  return data;
}

export async function endSession(sessionId) {
  const { data } = await api.post(`/session/${sessionId}/end`);
  return data;
}

export async function getStats(sessionId) {
  const { data } = await api.get(`/stats/${sessionId}`);
  return data;
}

export async function getHealth() {
  const { data } = await api.get('/health');
  return data;
}
