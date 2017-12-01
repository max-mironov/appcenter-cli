import { FileUploadServiceScript } from "./file-upload-service-script";
import { clientRequest, AppCenterClient, models } from "../../../../util/apis";
import { DefaultApp } from "../../../../util/profile";
import * as fs from "fs";
import { InflightModelChunk, IUploadStatus, IFullUploadData, IFileUploadSreviceRequest,
  FileUploadServiceState, IProgress, IUploadStats, IUploadData, MessageLevel } from "./file-upload-service-script-data";

//TODO: export it from service
export interface IFileUploadServiceDetails {
  id: string;
  location: string;
  token: string;
  upload_domain: string;
  upload_window_location: string;
  url_encoded_token: string;
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

export interface CustomFile {
  fileName: string,
  size: number,
  arrayBuffer: Buffer
}

export interface ClientResponse<T> {
  result: T;
  response: IncomingMessage;
}

import * as net from "net";
import * as stream from "stream";

export interface IncomingMessage extends stream.Readable {
  httpVersion: string;
  httpVersionMajor: number;
  httpVersionMinor: number;
  connection: net.Socket;
  headers: any;
  rawHeaders: string[];
  trailers: any;
  rawTrailers: any;
  setTimeout(msecs: number, callback: Function): NodeJS.Timer;
  /**
   * Only valid for request obtained from http.Server.
   */
  method?: string;
  /**
   * Only valid for request obtained from http.Server.
   */
  url?: string;
  /**
   * Only valid for response obtained from http.ClientRequest.
   */
  statusCode?: number;
  /**
   * Only valid for response obtained from http.ClientRequest.
   */
  statusMessage?: string;
  socket: net.Socket;
  destroy(error?: Error): void;
}

//TODO: add event handlers
export default class FileUploadHelper {

  private file: CustomFile;
  private fileUploadServiceDetails: models.FileAsset;
  private mcFusUpload: FileUploadServiceScript;
  private uploadPercent: number;
  private errorMessage: string;
  // private uploadStatus: UploadStatus;

  constructor(private client: AppCenterClient, private app: DefaultApp) {

  }

  public async upload(file: CustomFile): Promise<void> {
    this.file = file;

    const path = this.createAssetPath();
    //TODO: POST to current path and get public asset .then()...
    const httpRequest: any = await clientRequest<models.FileAsset> ((cb) => 
      this.client.appOperations.postFileAsset(this.app.ownerName, this.app.appName, cb)).catch((error: any) => {
        //TODO:log exception
      });
      
    let fileAsset: models.FileAsset = <models.FileAsset>JSON.parse(httpRequest.response.body);
    this.onCreateAssetComplete(fileAsset);

  }

  private onCreateAssetComplete(fileDetails: any) {
    this.fileUploadServiceDetails = fileDetails;

    const uploadSettings: IUploadData = {
      // Required settings
      assetId: fileDetails.id,
      token: fileDetails.token,
      uploadDomain: fileDetails.upload_domain,
      logToConsole: true,

      // custom event handlers
      onProgressChanged: this.uploadProgress.bind(this),
      onMessage: this.onMessage.bind(this),
      onCompleted: this.uploadComplete.bind(this),
      onStateChanged: this.onStateChanged.bind(this)
    };

    if (!this.mcFusUpload) {
      this.mcFusUpload = new FileUploadServiceScript(uploadSettings);
    } else {
      this.mcFusUpload.init(uploadSettings);
    }

    this.mcFusUpload.start(this.file);

  }

  private uploadProgress(progress: IProgress) {
    this.uploadPercent = progress.percentCompleted;
  }

  private onMessage() {

  }
  private uploadComplete() {
    
  }

  private onStateChanged(){

  }

  private createAssetPath(): string {
    //TODO: for testing
    return `/v0.1/apps/${this.app.ownerName}/${this.app.appName}/file_asset`;
  }
}