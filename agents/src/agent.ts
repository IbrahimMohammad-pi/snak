import { ChatAnthropic } from '@langchain/anthropic';
import { AiConfig } from '../common/index.js';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { ChatDeepSeek } from '@langchain/deepseek';
import { StarknetAgentInterface } from './tools/tools.js';
import { createSignatureTools } from './tools/signatureTools.js';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { createAllowedTools } from './tools/tools.js';
import {
  Annotation,
  MemorySaver,
  MessagesAnnotation,
  StateGraph,
} from '@langchain/langgraph';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import {
  DynamicStructuredTool,
  StructuredTool,
  Tool,
  tool,
} from '@langchain/core/tools';
import { z } from 'zod';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { LangGraphRunnableConfig } from '@langchain/langgraph';

import { CustomHuggingFaceEmbeddings } from './customEmbedding.js';
import { MCP_CONTROLLER } from './mcp/src/mcp.js';
import { JsonConfig } from './jsonConfig.js';
import logger from './logger.js';
import { createBox } from './formatting.js';
import {
  tokenTracker,
  configureModelWithTracking,
  addTokenInfoToBox,
  estimateTokens,
} from './tokenTracking.js';

export function selectModel(aiConfig: AiConfig) {
  let model;

  switch (aiConfig.aiProvider) {
    case 'anthropic':
      if (!aiConfig.aiProviderApiKey) {
        throw new Error(
          'Valid Anthropic api key is required https://docs.anthropic.com/en/api/admin-api/apikeys/get-api-key'
        );
      }
      model = new ChatAnthropic({
        modelName: aiConfig.aiModel,
        anthropicApiKey: aiConfig.aiProviderApiKey,
        verbose: aiConfig.langchainVerbose === true,
      });
      break;
    case 'openai':
      if (!aiConfig.aiProviderApiKey) {
        throw new Error(
          'Valid OpenAI api key is required https://platform.openai.com/api-keys'
        );
      }
      model = new ChatOpenAI({
        modelName: aiConfig.aiModel,
        openAIApiKey: aiConfig.aiProviderApiKey,
        verbose: aiConfig.langchainVerbose === true,
      });
      break;
    case 'gemini':
      if (!aiConfig.aiProviderApiKey) {
        throw new Error(
          'Valid Gemini api key is required https://ai.google.dev/gemini-api/docs/api-key'
        );
      }
      model = new ChatGoogleGenerativeAI({
        modelName: aiConfig.aiModel,
        apiKey: aiConfig.aiProviderApiKey,
        verbose: aiConfig.langchainVerbose === true,
      });
      break;
    case 'deepseek':
      if (!aiConfig.aiProviderApiKey) {
        throw new Error('Valid DeepSeek api key is required');
      }
      model = new ChatDeepSeek({
        modelName: aiConfig.aiModel,
        apiKey: aiConfig.aiProviderApiKey,
        verbose: aiConfig.langchainVerbose === true,
      });
      break;
    case 'ollama':
      model = new ChatOllama({
        model: aiConfig.aiModel,
        verbose: aiConfig.langchainVerbose === true,
      });
      break;
    default:
      throw new Error(`Unsupported AI provider: ${aiConfig.aiProvider}`);
  }

  // Add token tracking with configurable limits
  return configureModelWithTracking(model, {
    tokenLogging: aiConfig.langchainVerbose !== false,
    maxInputTokens: aiConfig.maxInputTokens || 50000,
    maxCompletionTokens: aiConfig.maxCompletionTokens || 50000,
    maxTotalTokens: aiConfig.maxTotalTokens || 100000,
  });
}

export async function initializeToolsList(
  starknetAgent: StarknetAgentInterface,
  jsonConfig: JsonConfig
): Promise<(Tool | DynamicStructuredTool<any> | StructuredTool)[]> {
  let toolsList: (Tool | DynamicStructuredTool<any> | StructuredTool)[] = [];
  const isSignature = starknetAgent.getSignature().signature === 'wallet';

  if (isSignature) {
    toolsList = await createSignatureTools(jsonConfig.plugins);
  } else {
    const allowedTools = await createAllowedTools(
      starknetAgent,
      jsonConfig.plugins
    );
    toolsList = [...allowedTools];
  }

  if (jsonConfig.mcpServers && Object.keys(jsonConfig.mcpServers).length > 0) {
    try {
      const mcp = MCP_CONTROLLER.fromJsonConfig(jsonConfig);
      await mcp.initializeConnections();

      const mcpTools = mcp.getTools();
      logger.info(`Added ${mcpTools.length} MCP tools to the agent`);
      toolsList = [...toolsList, ...mcpTools];
    } catch (error) {
      logger.error(`Failed to initialize MCP tools: ${error}`);
    }
  }

  return toolsList;
}

// Patch ToolNode to log all tool calls
const originalToolNodeInvoke = ToolNode.prototype.invoke;
ToolNode.prototype.invoke = async function (state: any, config: any) {
  // Save the last message with tool calls
  if (state.messages && state.messages.length > 0) {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
      // Create a clear format for displaying tools
      // For each tool, create a complete entry with name and arguments
      const toolCalls = [];

      for (const toolCall of lastMessage.tool_calls) {
        let argsStr;
        try {
          if (typeof toolCall.args === 'object') {
            const argsObj = toolCall.args;
            const isSimpleObject =
              Object.keys(argsObj).length <= 3 &&
              !Object.values(argsObj).some(
                (v) => typeof v === 'object' && v !== null
              );

            argsStr = isSimpleObject
              ? JSON.stringify(argsObj)
              : JSON.stringify(argsObj, null, 2);
          } else {
            argsStr = String(toolCall.args);
          }
        } catch (e) {
          argsStr = 'Error parsing arguments';
        }

        toolCalls.push(`Tool: ${toolCall.name}`);
        toolCalls.push(`Arguments: ${argsStr}`);
        toolCalls.push('');
      }

      // Use process.stdout.write directly to ensure immediate display
      const boxContent = createBox('Agent Action', toolCalls, {
        title: 'Agent Action',
      });

      // Add token information to the box
      const boxWithTokens = addTokenInfoToBox(boxContent);
      process.stdout.write(boxWithTokens);
    }
  }

  // Call the original method
  return originalToolNodeInvoke.apply(this, [state, config]);
};

export const createAgent = async (
  starknetAgent: StarknetAgentInterface,
  aiConfig: AiConfig
) => {
  const embeddings = new CustomHuggingFaceEmbeddings({
    model: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'fp32',
  });
  const embeddingDimensions = 384; //1536 for OpenAI, 512 for TensorFlow, 384 for HuggingFace

  try {
    const json_config = starknetAgent.getAgentConfig();
    if (!json_config) {
      throw new Error('Agent configuration is required');
    }

    let databaseConnection = null;
    if (json_config.memory) {
      const databaseName = json_config.chat_id;
      databaseConnection = await starknetAgent.createDatabase(databaseName);
      if (!databaseConnection) {
        throw new Error('Failed to create or connect to database');
      }
      try {
        const dbCreation = await databaseConnection.createTable({
          table_name: 'agent_memories',
          fields: new Map<string, string>([
            ['id', 'SERIAL PRIMARY KEY'],
            ['user_id', 'VARCHAR(100)'],
            ['content', 'TEXT'],
            ['embedding', `vector(${embeddingDimensions})`],
            ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
            ['updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
            ['metadata', 'TEXT'],
            ['history', "JSONB DEFAULT '[]'"],
          ]),
        });
        if (dbCreation.code == '42P07')
          logger.warn('Agent memory table already exists');
        else logger.debug('Agent memory table successfully created');
      } catch (error) {
        console.error('Error creating memories table:', error);
        throw error;
      }
    }

    let toolsList = await initializeToolsList(starknetAgent, json_config);

    const GraphState = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        reducer: (x, y) => x.concat(y),
      }),
      memories: Annotation<string>,
    });

    const upsertMemoryToolDB = tool(
      async (
        { content, memoryId },
        config: LangGraphRunnableConfig
      ): Promise<string> => {
        try {
          const userId = config.configurable?.userId || 'default_user';
          const embeddingResult = await embeddings.embedQuery(content);
          const embeddingString = `[${embeddingResult.join(',')}]`;
          const metadata = JSON.stringify({
            timestamp: new Date().toISOString(),
          });
          console.log('\nCalling memory tool');
          if (memoryId) {
            console.log('\nmemoryId detected : ', memoryId);
            const response = await databaseConnection?.select({
              FROM: ['agent_memories'],
              SELECT: ['content', 'history', 'created_at'],
              WHERE: [`id = ${memoryId}`],
            });
            if (
              response?.status === 'success' &&
              response.query &&
              response.query.rows.length > 0
            ) {
              const existingMemory = response.query.rows[0];
              const oldContent = existingMemory.content;
              let history = existingMemory.history;
              if (!history) {
                history = [];
              } else if (typeof history === 'string') {
                try {
                  history = JSON.parse(history);
                } catch (e) {
                  console.error('Error parsing history : ', e);
                  history = [];
                }
              }
              const timestamp = new Date().toISOString();
              history.push({
                value: oldContent,
                timestamp: timestamp,
                action: 'UPDATE',
              });

              const historyString = JSON.stringify(history);
              const updateResponse = await databaseConnection?.update({
                table_name: 'agent_memories',
                ONLY: true,
                SET: [
                  `content = '${content.replace(/'/g, "''")}'`,
                  `embedding = '${embeddingString.replace(/'/g, "''")}'`,
                  `updated_at = CURRENT_TIMESTAMP`,
                  `history = '${historyString.replace(/'/g, "''")}'`,
                ],
                WHERE: [`id = ${memoryId}`],
              });

              if (updateResponse?.status === 'success') {
                return 'Memory updated successfully.';
              } else {
                throw new Error(
                  `Failed to update memory : ${updateResponse?.error_message}`
                );
              }
            }
          }
          //console.log('\nInserting inside the table : ', content);
          if (databaseConnection) {
            await databaseConnection.insert({
              table_name: 'agent_memories',
              fields: new Map<string, string | string[]>([
                ['id', 'DEFAULT'],
                ['user_id', userId],
                ['content', content],
                ['embedding', embeddingString],
                ['metadata', metadata],
                ['history', '[]'],
              ]),
            });
          }

          return 'Memory stored successfully.';
        } catch (error) {
          console.error('Error storing memory:', error);
          return 'Failed to store memory.';
        }
      },
      {
        name: 'upsert_memory',
        schema: z.object({
          content: z.string().describe('The content of the memory to store.'),
          memoryId: z
            .number()
            .optional()
            .nullable()
            .describe('Memory ID when wanting to update an existing memory.'),
        }),
        description: `
		  CREATE, UPDATE or DELETE persistent MEMORIES to persist across conversations.
		  In your system prompt, you have access to the MEMORIES relevant to the user's
		   query, each having their own MEMORY ID. Include the MEMORY ID when updating
		   or deleting a MEMORY. Omit when creating a new MEMORY - it will be created for
		   you. Proactively call this tool when you:
		   1.Identify a new USER preference.
		   2.Receive an explicit USER request to remember something or otherwise alter your behavior.
		   3. Are working and want to record important context.
		   4. Identify that an existing MEMORY is incorrect or outdated.
		  `,
      }
    );

    const addMemoriesFromDB = async (
      state: typeof MessagesAnnotation.State,
      config: LangGraphRunnableConfig
    ) => {
      try {
        if (!databaseConnection)
          return {
            memories: '',
          };
        const userId = config.configurable?.userId || 'default_user';
        const lastMessage = state.messages[state.messages.length - 1]
          .content as string;
        const queryEmbedding = await embeddings.embedQuery(lastMessage);
        const queryEmbeddingStr = `[${queryEmbedding.join(',')}]`;
        const similarMemoriesQuery = `
          SELECT id, content, history, 1 - (embedding <=> '${queryEmbeddingStr}'::vector) as similarity
          FROM agent_memories
          WHERE user_id = '${userId}'
          ORDER BY similarity DESC
          LIMIT 4
        `;

        const results = await databaseConnection.query(similarMemoriesQuery);

        let memories = '\n';
        if (
          results.status === 'success' &&
          results.query &&
          results.query.rows.length > 0
        ) {
          memories = results.query.rows
            .map((row) => {
              let historyStr = '[]';
              try {
                if (row.history) {
                  if (typeof row.history === 'string') {
                    historyStr = row.history;
                  } else {
                    historyStr = JSON.stringify(row.history);
                  }
                }
              } catch (e) {
                console.error('Error stringifying history:', e);
              }
              return `Memory [id: ${row.id}, similarity: ${row.similarity.toFixed(4)},history : ${historyStr}]: ${row.content}`;
            })
            .join('\n');
        }
        return {
          memories: memories,
        };
      } catch (error) {
        console.error('Error retrieving memories:', error);
        return {
          memories: '',
        };
      }
    };

    const toolNode = new ToolNode(toolsList);
    const modelSelected = selectModel(aiConfig).bindTools(toolsList);

    const configPrompt = json_config.prompt?.content;
    const memoryPrompt = ``;
    const finalPrompt = json_config.memory
      ? `${configPrompt}\n${memoryPrompt}`
      : `${configPrompt}`;

    async function callModel(
      state: typeof GraphState.State
    ): Promise<{ messages: BaseMessage[] }> {
      const prompt = ChatPromptTemplate.fromMessages([
        [
          'system',
          `${finalPrompt}

          {system_message}`,
        ],
        new MessagesPlaceholder('messages'),
      ]);

      try {
        const formattedPrompt = await prompt.formatMessages({
          system_message: '',
          tool_names: toolsList.map((tool) => tool.name).join(', '),
          messages: state.messages,
          memories: state.memories || '',
        });

        // Estimate message size and check limit
        const estimatedTokens = estimateTokens(JSON.stringify(formattedPrompt));
        if (estimatedTokens > 90000) {
          // Safety limit to avoid token errors
          logger.warn(
            `Prompt exceeds safe token limit: ${estimatedTokens} tokens. Truncating messages...`
          );

          // Create a truncated version of input messages
          // Only keep the last 4 messages
          const truncatedMessages = state.messages.slice(-4);

          // Reformat the prompt with truncated messages
          const truncatedPrompt = await prompt.formatMessages({
            system_message: '',
            tool_names: toolsList.map((tool) => tool.name).join(', '),
            messages: truncatedMessages,
            memories: state.memories || '',
          });

          // Use truncated prompt
          const result = await modelSelected.invoke(truncatedPrompt);
          return {
            messages: [result],
          };
        }

        // If we're below the limit, use the full prompt
        const result = await modelSelected.invoke(formattedPrompt);
        return {
          messages: [result],
        };
      } catch (error) {
        // Handle token limit errors specifically
        if (
          error instanceof Error &&
          (error.message.includes('token limit') ||
            error.message.includes('tokens exceed') ||
            error.message.includes('context length'))
        ) {
          logger.error(`Token limit error: ${error.message}`);

          // Create a very reduced version with only the last message
          const minimalMessages = state.messages.slice(-2);

          try {
            // Try with a minimal prompt
            const emergencyPrompt = await prompt.formatMessages({
              system_message:
                'Previous conversation was too long. Continuing with just recent messages.',
              tool_names: toolsList.map((tool) => tool.name).join(', '),
              messages: minimalMessages,
              memories: '',
            });

            const result = await modelSelected.invoke(emergencyPrompt);
            return {
              messages: [result],
            };
          } catch (emergencyError) {
            // If even the emergency prompt fails, return a formatted error message
            return {
              messages: [
                new AIMessage({
                  content:
                    'The conversation has become too long and exceeds token limits. Please start a new conversation.',
                }),
              ],
            };
          }
        }

        // For other types of errors, propagate them
        throw error;
      }
    }

    function shouldContinue(state: typeof GraphState.State) {
      const messages = state.messages;
      const lastMessage = messages[messages.length - 1] as AIMessage;

      if (lastMessage.tool_calls?.length) {
        return 'tools';
      }
      return 'end';
    }

    const workflow = new StateGraph(GraphState)
      .addNode('agent', callModel)
      .addNode('tools', toolNode);
    if (json_config.memory) {
      workflow
        .addNode('memory', addMemoriesFromDB)
        .addEdge('__start__', 'memory')
        .addEdge('memory', 'agent');
    } else {
      workflow.addEdge('__start__', 'agent');
    }
    workflow
      .addConditionalEdges('agent', shouldContinue)
      .addEdge('tools', 'agent');

    const checkpointer = new MemorySaver();
    const app = workflow.compile({
      ...(json_config.memory
        ? {
            checkpointer: checkpointer,
            configurable: {},
          }
        : {}),
    });

    return app;
  } catch (error) {
    logger.error('Failed to create an agent:', error);
    throw error;
  }
};
