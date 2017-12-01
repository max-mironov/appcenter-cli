import { CustomFile } from "./file-upload-helper";

export interface IInflightChunk {
  getWorker(): any;
  getChunkNumber(): number;
  getStarted(): Date;
}

export enum FileUploadServiceState {
  New = 0,
  Initialized = 10,
  Uploading = 20,
  ResumeOrRestart = 40,
  Paused = 50,
  Unsupported = 60,
  Cancelled = 80,
  Verifying = 90,
  Completed = 100,
  FatalError = 500
}

export interface IProgress {
  percentCompleted: number;
  rate: string;
  averageSpeed: string;
  timeRemaining: string;
}

export interface IUploadStats {
  assetId: string;
  totalTimeInSeconds: string;
  averageSpeedInMbps: string;
}

export enum MessageLevel {
  Information = 0,
  Verbose = 1,
  Error = 2
}

export interface IUploadData {
  assetId: string;
  token: string;
  uploadDomain: string;
  logToConsole: boolean;
  onProgressChanged(progress: IProgress): void;
  onCompleted(uploadStats: IUploadStats): void;
  onMessage(errorMessage: string, mcFusMessageLevel: MessageLevel): void;
  onStateChanged(status: FileUploadServiceState): void;
}

export class InflightModelChunk implements IInflightChunk {

  private chunkNumber: number;
  private started: Date;
  private worker: any;

  public constructor(chunk: number, worker: any) {
    this.worker = worker;
    this.chunkNumber = chunk;
    this.started = new Date();
  }

  public getWorker(): any {
    return this.worker;
  }
  public getChunkNumber(): number {
    return this.chunkNumber;
  }
  public getStarted(): Date {
    return this.started;
  }
}

export interface IFullUploadData extends IUploadData {
  blobPartitions: number;
  callbackUrl: string;
  correlationId: string;
  correlationVector: string;
  chunkSize: number;
  notifyParentWindow: boolean;
  singleThreadMaxUploadSize: number;
  totalBlocks: number;
  uploaders: number;
  workerScript: string;
  file: CustomFile;
}

export interface IUploadStatus {
  inflightChunks: InflightModelChunk[];
  autoRetryCount: number;
  averageSpeed: number;
  blocksCompleted: number;
  chunkQueue: number[];
  endTime: Date;
  healthCheckRunning: boolean;
  serviceCallback: {
    autoRetryCount: 5,
    autoRetryDelay: 1,
    failureCount: 0
  };
  state: FileUploadServiceState;
  transferQueueRate: number[];
  workers: Worker[];
  workerErrorCount: number;
  startTime: Date;
}

export interface IFileUploadSreviceRequest {
  method: string;
  async: boolean;
  useAuthentication: boolean;
  url: string;
  chunk?: any;
  onError(event: any, errorMsg: string): void;
  onSuccess(data: any): void;
}

export interface IWorkerMessage {
  message: string;
  error: boolean;
  chunkNumber: number;
}
