# Real-Time Chat Application

A WhatsApp-inspired real-time chat application with end-to-end encryption using Next.js, Node.js, Socket.IO, and Supabase.

## Features

- User authentication with Supabase Auth
- One-to-one private messaging
- Real-time messaging with Socket.IO
- End-to-end encryption using libsodium.js
- Online/offline status
- Typing indicators
- Message timestamps
- Responsive UI with dark mode
- Chat sidebar with recent conversations
- Auto-scroll to latest messages

## Tech Stack

### Frontend

- Next.js 16
- TypeScript
- Tailwind CSS
- Socket.IO Client
- Framer Motion (animations)
- Lucide React (icons)

### Backend

- Node.js
- Express.js
- Socket.IO
- TypeScript

### Database

- Supabase (PostgreSQL with real-time subscriptions)

### Encryption

- libsodium.js for end-to-end encryption

## Setup Instructions

### Prerequisites

- Node.js 18+
- npm or yarn
- Supabase account
- Docker (optional)

### 1. Clone the repository

```bash
git clone <repository-url>
cd myChat
```

### 2. Supabase Setup

1. Create a new project on [Supabase](https://supabase.com)
2. Go to SQL Editor and run the schema from `supabase-schema.sql`
3. Get your project URL and anon key from Settings > API

### 3. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your Supabase credentials
npm run dev
```

### 4. Frontend Setup

```bash
cd frontend
npm install
cp .env.example .env.local
# Edit .env.local with your Supabase credentials
npm run dev
```

### 5. Access the application

- Frontend: http://localhost:3000
- Backend: http://localhost:4000

## Environment Variables

### Backend (.env)

```
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
FRONTEND_URL=http://localhost:3000
PORT=4000
```

### Frontend (.env.local)

```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
NEXT_PUBLIC_BACKEND_URL=http://localhost:4000
```

## Deployment

### Frontend (Vercel)

1. Connect your GitHub repository to Vercel.
2. Set the project root to `frontend`.
3. Add the following environment variables in Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_BACKEND_URL`
4. Deploy.

The project includes `frontend/vercel.json` to help Vercel understand the build.

### Backend (Render)

1. Create a new Web Service on Render.
2. Connect your GitHub repository.
3. Set the root directory to `backend`.
4. Set build command:
   ```bash
   npm install && npm run build
   ```
5. Set start command:
   ```bash
   npm start
   ```
6. Add environment variables from `backend/.env`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `FRONTEND_URL`
   - `PORT`
7. Deploy.

The repository includes `render.yaml` for Render manifest support.

### Optional Docker Deployment

Use Docker for local or cloud container deployment:

```bash
# Backend
cd backend
docker build -t chat-backend .
docker run -p 4000:4000 chat-backend

# Frontend
cd frontend
docker build -t chat-frontend .
docker run -p 3000:3000 chat-frontend
```

## Security Notes

- Messages are encrypted on the client-side before sending to the server
- Server only stores encrypted message blobs
- Private keys are stored locally on the client (in production, consider secure key storage)
- All communication uses HTTPS in production

## API Endpoints

### Backend

- `GET /api/conversations` - Get user's conversations
- `POST /api/conversations` - Create new conversation

### Socket Events

- `join_conversation` - Join a conversation room
- `send_message` - Send encrypted message
- `new_message` - Receive new message
- `set_online` - Set user online
- `user_online` - User came online
- `user_offline` - User went offline
- `typing` - User is typing
- `user_typing` - Typing indicator

## Project Structure

```
myChat/
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/
│   │   └── types/
│   ├── package.json
│   └── .env.example
├── backend/
│   ├── src/
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── supabase-schema.sql
├── README.md
└── docker-compose.yml (optional)
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License
