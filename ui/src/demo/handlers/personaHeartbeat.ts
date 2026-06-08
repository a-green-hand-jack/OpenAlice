import { http, HttpResponse } from 'msw'

export const personaHeartbeatHandlers = [
  http.get('/api/persona', () =>
    HttpResponse.json({ content: '# Demo Persona\n\nDemo mode — persona is read-only.', path: '/demo/persona.md' }),
  ),
  http.put('/api/persona', () => HttpResponse.json({ ok: true })),
]
