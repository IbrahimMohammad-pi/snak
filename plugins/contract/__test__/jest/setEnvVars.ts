import { setupTestEnvironment } from '../utils/helper.js';
import { RpcProvider } from 'starknet';
import { StarknetAgentInterface, JsonConfig } from '@starknet-agent-kit/agents';
import { SystemMessage } from '@langchain/core/messages';

setupTestEnvironment();

export const createMockStarknetAgent = (): StarknetAgentInterface => {
  const provider = new RpcProvider({ nodeUrl: 'http://127.0.0.1:5050' });
  const mockSystemMessage = new SystemMessage('Default system prompt');

  const json_config: JsonConfig = {
    name: 'MockAgent',
    prompt: mockSystemMessage,
    interval: 1000,
    chat_id: 'mock_chat_id',
    plugins: [],
    memory: false,
  };

  return {
    getAccountCredentials: () => ({
      accountPublicKey:
        '0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691',
      accountPrivateKey:
        '0x0000000000000000000000000000000071d7bb07b9a64f6f78ac4c816aff4da9',
    }),
    getModelCredentials: () => ({
      aiModel: '',
      aiProviderApiKey: '',
    }),
    getSignature: () => ({
      signature: '',
    }),
    getProvider: () => provider,
    getAgentConfig: () => json_config,
    getDatabase: () => [],
    connectDatabase: async () => {},
    createDatabase: async () => undefined,
    getDatabaseByName: () => undefined,
  };
};

export const createMockInvalidStarknetAgent = (): StarknetAgentInterface => {
  const provider = new RpcProvider({ nodeUrl: 'http://127.0.0.1:5050' });
  const mockSystemMessage = new SystemMessage('Default system prompt');

  const json_config: JsonConfig = {
    name: 'MockAgent',
    prompt: mockSystemMessage,
    interval: 1000,
    chat_id: 'mock_chat_id',
    plugins: [],
    memory: false,
  };

  return {
    getAccountCredentials: () => ({
      accountPublicKey: 'dlksjflkdsjf',
      accountPrivateKey: 'dsfahdskfgdsjkah',
    }),
    getModelCredentials: () => ({
      aiModel: '',
      aiProviderApiKey: '',
    }),
    getSignature: () => ({
      signature: '',
    }),
    getProvider: () => provider,
    getAgentConfig: () => json_config,
    getDatabase: () => [],
    connectDatabase: async () => {},
    createDatabase: async () => undefined,
    getDatabaseByName: () => undefined,
  };
};
