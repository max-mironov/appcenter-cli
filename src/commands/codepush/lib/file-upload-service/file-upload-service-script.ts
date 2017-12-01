
import { InflightModelChunk, IUploadStatus, IFullUploadData, IFileUploadSreviceRequest,
  FileUploadServiceState, IProgress, IUploadStats, IUploadData, MessageLevel } from "./file-upload-service-script-data";

  export interface CustomFile {
    fileStream: fs.ReadStream,
    size: number,
    name: string
  }

  var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
  var xhr = new XMLHttpRequest();

const urlParse = require('url-parse');
import * as fs from "fs";
var slice = require('stream-slice').slice;

const failToUploadMsg = 'The asset cannot be uploaded. Try creating a new one';

const uploadBaseUrls = {
  CancelUpload: '/upload/cancel/',
  SetMetadata: '/upload/set_metadata/',
  UploadChunk: '/upload/upload_chunk/',
  UploadFinished: '/upload/finished/',
  UploadStatus: '/upload/status/'
};

const maxNumberOfConcurrentUploads = 10;
const maxWorkerAgeInSeconds = 40;
const maxNumberOfRecoveredWorkers = 16;

export class FileUploadServiceScript {

  private uploadStatus: IUploadStatus;
  private uploadData: IFullUploadData;
  private progressUpdateRate: number;
  private maxSingleThreadUploadSize: number;

  constructor(uploadData: IUploadData) {
    this.initializeUpload(uploadData);
  }

  private initializeUpload(settings: IUploadData) {
    this.progressUpdateRate = 0;
    this.maxSingleThreadUploadSize = 0;

    // Validate required arguments if any 
    // is missing the upload will fail.
    if (!this.hasRequiredSettings(settings)) {
      return;
    }

    // Initialize all retry flags for the new upload.
    this.uploadStatus = {
      autoRetryCount: 3,
      blocksCompleted: 0,
      serviceCallback: {
        autoRetryCount: 5,
        autoRetryDelay: 1,
        failureCount: 0
      },
      workerErrorCount: 0,
      healthCheckRunning: false,
      averageSpeed: 0,
      chunkQueue: [],
      endTime: null,
      inflightChunks: [],
      startTime: null,
      state: FileUploadServiceState.New,
      transferQueueRate: [],
      workers: [],
    };

    // Copy all the required settings on to the upload data.
    this.initUploadData(settings);

    this.setState(FileUploadServiceState.New);
    this.trackEvent("UploadInitialized");
    this.log("Upload Initialized");
  }

  private initUploadData(uploadData: IUploadData) {

    this.uploadData = {
      assetId: uploadData.assetId,
      token: uploadData.token,
      uploadDomain: uploadData.uploadDomain,
      logToConsole: uploadData.logToConsole,
      onCompleted: uploadData.onCompleted,
      onMessage: uploadData.onMessage,
      onProgressChanged: uploadData.onProgressChanged,
      onStateChanged: uploadData.onStateChanged,

      blobPartitions: 0,
      callbackUrl: '',
      correlationId: uploadData.assetId,
      correlationVector: '',
      chunkSize: 0,
      notifyParentWindow: false,
      singleThreadMaxUploadSize: 2,
      totalBlocks: 0,
      uploaders: 8,
      workerScript: './mc-fus-worker.js',
      file: null
    };
  }

  protected calculateAverageSpeed(): number {
    if (this.uploadStatus.transferQueueRate.length === 0) {
      return 0;
    }
    let rateSum = 0;
    for (const transferRate of this.uploadStatus.transferQueueRate) {
      rateSum += transferRate;
    }

    return rateSum / this.uploadStatus.transferQueueRate.length;
  }

  protected calculateRate(): number {
    // Get the ellapsed time in seconds
    const diff = new Date().valueOf() - this.uploadStatus.startTime.valueOf();
    const seconds = diff / 1000;

    // Megabytes per second
    const speed: number = ((this.uploadStatus.blocksCompleted * this.uploadData.chunkSize) / 1024 / 1024) / seconds;

    // Times 8 to convert bits to bytes
    return (speed * 8);
  }

  protected calculateTimeRemaining(): number {

    // calculate time remaining using chunks to avoid hitting the disc for size
    const dataRemaining = (this.uploadStatus.chunkQueue.length) * this.uploadData.chunkSize;
    if (this.uploadStatus.averageSpeed > 0 && dataRemaining > 0) {

      let timeInSeconds = (dataRemaining * 8) / (1024 * 1024 * this.uploadStatus.averageSpeed);
      const hours = Math.floor(timeInSeconds / 60 / 60);
      timeInSeconds -= (hours * 60 * 60);
      return timeInSeconds;
    } else if (this.uploadStatus.averageSpeed === 0 && dataRemaining > 0) {
      this.log(`something went wrong averageSpeed is 0 but the dataRemaining is: ${dataRemaining}`);
    }
    return 0;
  }

  private completeUpload() {

    // Only raise the completed event if we've not done it before, this can happen
    // due to a race condition on status checks calling finishUpload simultaneously
    if (this.uploadStatus.state === FileUploadServiceState.Completed) {
      return;
    }

    const rate = this.calculateRate();
    const diff = this.uploadStatus.endTime.valueOf() - this.uploadStatus.startTime.valueOf();
    const seconds = diff / 1000;

    const uploadStats: IUploadStats = {
      assetId: this.uploadData.assetId,
      totalTimeInSeconds: seconds.toFixed(1),
      averageSpeedInMbps: rate.toFixed(2)
    };

    this.setState(FileUploadServiceState.Completed);
    const completeMessage = `Upload completed in:  ${uploadStats.totalTimeInSeconds} seconds. Average speed: ${uploadStats.averageSpeedInMbps} Mbps.`;
    this.trackEvent('UploadCompleted', { UploadFileSize: this.uploadData.file.size }, { UploadSpeed: uploadStats.averageSpeedInMbps, EllapsedSeconds: uploadStats.totalTimeInSeconds });
    this.log(completeMessage);
    this.message(completeMessage);

    if (this.uploadData.onCompleted) {
      this.uploadData.onCompleted(uploadStats);
    }
  }

  private dispatchWorker(worker: Worker): void {

    // if we are done then call finished and return
    if (this.uploadStatus.chunkQueue.length === 0) {
      this.removeWorker(worker);
      this.log('Worker finished.');
      return;
    }

    // if we are not uploading chunks there is nothing to do.
    if (this.uploadStatus.state !== FileUploadServiceState.Uploading) {
      return;
    }

    const chunkToSend = this.uploadStatus.chunkQueue.shift();

    // If other worker beat us to grab a chunk we're done
    if (chunkToSend === undefined) {
      return;
    }

    // Otherwise just start processing and uploading the chunk
    const start = (chunkToSend - 1) * this.uploadData.chunkSize;
    const end = Math.min(chunkToSend * this.uploadData.chunkSize, this.uploadData.file.size);
    const chunk = this.uploadData.file.fileStream.pipe(slice(start, end));
    const url = uploadBaseUrls.UploadChunk + this.uploadData.assetId + '?blockNumber=' + chunkToSend + '&token=' + this.uploadData.token;

    worker.postMessage({ Chunk: chunk, ChunkNumber: chunkToSend, Url: url, CorrelationId: this.uploadData.correlationId, CorrelationVector: this.uploadData.correlationVector });

    // Track the current chunk as in-flight.
    this.uploadStatus.inflightChunks.push(new InflightModelChunk(chunkToSend, worker));
  }

  protected enqueueChunks(chunks: number[]): void {
    // if the queue is empty then just add all the chunks
    if (this.uploadStatus.chunkQueue.length === 0) {
      this.uploadStatus.chunkQueue = chunks;
      return;
    }

    // if there something in the queue don't re-add a chunk. This
    // can result in more than one thread uploading the same chunk
    const me = this;
    this.uploadStatus.chunkQueue.concat(chunks.filter(function (chunk) {
      return me.uploadStatus.chunkQueue.indexOf(chunk) < 0;
    }));
  }

  protected error(errorMessage: string, data: any) {

    this.setState(FileUploadServiceState.FatalError);
    this.trackError(errorMessage, data);

    if (this.uploadData.onMessage) {
      this.uploadData.onMessage(errorMessage, MessageLevel.Error);
    }
  }

  private extend(obj: any, extObj: any): void {
    if (arguments.length > 2) {
      for (let a = 1; a < arguments.length; a++) {
        this.extend(obj, arguments[a]);
      }
    } else {
      for (const i in extObj) {
        obj[i] = extObj[i];
      }
    }
  }

  protected finishUpload(): void {

    // Only verify the upload once at a time
    if (this.uploadStatus.state === FileUploadServiceState.Verifying ||
      this.uploadStatus.state === FileUploadServiceState.Completed) {
      return;
    }

    this.setState(FileUploadServiceState.Verifying);
    this.message('Verifying upload on server.', MessageLevel.Information);

    this.stopAllWorkers();

    this.sendRequest({
      method: 'POST',
      async: true,
      useAuthentication: true,
      url: uploadBaseUrls.UploadFinished + encodeURIComponent(this.uploadData.assetId),
      onError: (event: any, errorMessage: string) => {
        this.log(`Finalize upload failed. ${errorMessage}`);
        this.error(failToUploadMsg,
          {
            message: 'Finalize upload failed',
            errorMessage: errorMessage ? errorMessage : 'none',
            eventStatusCode: event.currentTarget && event.currentTarget.status ? event.currentTarget.status : 'none'            
          });
      },
      onSuccess: this.onSuccessFinishUpload.bind(this)
    });
  }

  private onSuccessFinishUpload(response: any): void {

    // it's possible that the health check called complete before this method did.
    // Log the current status and proceed with response verification.
    if (this.uploadStatus.state !== FileUploadServiceState.Verifying) {
      this.log(`Verifying: Upload status has changed, current status:  ${this.uploadStatus.state}`);
    }

    // if no error then execute callback
    if (response.error === false && response.state === 'Done') {

      this.log(`McFus reported the upload as completed. Status message: ${response.message}`);
      this.log(response.Location);
      this.trackEvent('UploadFinalized');

      // Report upload completion.
      this.completeUpload();

    } else {

      // if chunks are missing enqueue missing chunks
      if (response.missing_chunks && response.missing_chunks.length > 0) {

        // If there are missing chunks lets adjust the completed count.
        this.uploadStatus.blocksCompleted = this.uploadData.totalBlocks - response.missing_chunks.length;

        this.enqueueChunks(response.missing_chunks);
        this.setState(FileUploadServiceState.Uploading);

        this.message(`Finalizing found missing  ${response.missing_chunks.length} chunks. Requeuing chunks.`, MessageLevel.Information);
        this.trackEvent('UploadAutoRecovery', { chunksMissing: response.missing_chunks });

        if (this.useSingleThreadUploader()) {
          this.singleThreadedUpload();
        }
        return;
      }

      // if no chunks are missing this must be an unhandled error
      // display the details to the user and stop the upload.
      this.error(response.message, null);
    }
  }

  private formatAsDoubleDigit(numberToCheck: number): string {
    return numberToCheck >= 0 && numberToCheck < 10 ?
      '0' + numberToCheck :
      numberToCheck.toString();
  }

  private hasRequiredSettings(settings: IUploadData): boolean {

    let hasSettings = true;

    if (!settings.assetId) {
      hasSettings = false;
      this.message('An AssetId must be specified.');
    }

    if (!settings.token) {
      hasSettings = false;
      this.message('The upload Token must be specified.');
    }

    if (!settings.uploadDomain) {
      hasSettings = false;
      this.message('The UploadDomain must be specified.');
    }
    return hasSettings;
  }

  protected healthCheck(): void {
    // Only allow one health check at a time.
    if (this.uploadStatus.healthCheckRunning === true) {
      return;
    }

    if (this.useSingleThreadUploader()) {
      return this.singleThreadHealthCheck();
    }

    this.uploadStatus.healthCheckRunning = true;
    this.log('Health check: ' + this.toTimeString(new Date()));

    // If the we are not uploading there's nothing to check.
    if (!this.isUploadInProgress()) {
      this.log('Upload is not in progress. Stopping health check.');
      this.uploadStatus.healthCheckRunning = false;
      return;
    }

    this.multiThreadHealthCheck();
  }

  private singleThreadHealthCheck(): void {

    if (this.uploadStatus.workers.length > 0) {
      this.stopAllWorkers();
    } else {
      this.setState(FileUploadServiceState.Uploading);
    }

    for (let i = 0; i < maxNumberOfConcurrentUploads; i++) {
      this.singleThreadedUpload();
    }
    return;
  }

  private multiThreadHealthCheck(): void {

    // Look at the current queue and determine if there's pending work
    if (this.uploadStatus.chunkQueue.length === 0 && this.uploadStatus.workers.length === 0) {
      this.uploadStatus.endTime = new Date();
      this.finishUpload();
    } else {

      // Calculate the current chunk age and see if its considered as stale.
      const now = new Date();
      const stuckChunks = [];

      for (const inflightChunks of this.uploadStatus.inflightChunks) {
        // If a chunk has exceeded its maximum time to live we assume it has
        // become stale, proceed to terminate it and create a replacement
        const ageInSeconds = (now.getTime() - inflightChunks.getStarted().getTime()) / 1000;
        if (ageInSeconds > maxWorkerAgeInSeconds) {
          stuckChunks.push(inflightChunks);
        }
      }

      for (const stuckChunk of stuckChunks) {
        
        this.removeInflightChunk(stuckChunk.getChunkNumber());
        this.uploadStatus.chunkQueue.push(stuckChunk.getChunkNumber());

        // Replace the stuck worker with a new one.
        this.removeWorker(stuckChunk.getWorker());
        this.startWorker();

        // Keep track of the amount of replaced workers.
        this.uploadStatus.workerErrorCount++;
      }
    }

    if (this.uploadStatus.workers.length === 0 && this.uploadStatus.chunkQueue.length > 0) {
      this.initWorkers();
    }

    this.uploadStatus.healthCheckRunning = false;
    setTimeout(this.healthCheck.bind(this), 5 * 1000);
  }

  private initWorkers(): void {

    // Mark the current upload as in progress
    this.setState(FileUploadServiceState.Uploading);

    // Kill all existing workers (if any)
    if (this.uploadStatus.workers.length > 0) {
      this.stopAllWorkers();
    }

    // Calculate the number of worker threads to use
    const numberOfWorkers = Math.min(this.uploadData.uploaders, this.uploadStatus.chunkQueue.length);
    this.log(`# of workers needed: ${numberOfWorkers}`);

    for (let i = 0; i < numberOfWorkers; i++) {
      // Stagger worker creation to avoid startup contention
      this.startWorker();
    }
  }

  private isUploadInProgress(): boolean {
    return this.uploadStatus.state === FileUploadServiceState.Initialized ||
      this.uploadStatus.state === FileUploadServiceState.Uploading ||
      this.uploadStatus.state === FileUploadServiceState.Verifying;
  }

  protected log(information: string): void {

    if (this.uploadData.logToConsole === true) {
      console.log(information);
    }

    if (this.uploadData.onMessage) {
      this.uploadData.onMessage(information, MessageLevel.Verbose);
    }
  }

  private message(text: string, level?: MessageLevel): void {

    if (!level) {
      level = MessageLevel.Information;
    }

    if (this.uploadData.onMessage) {
      this.uploadData.onMessage(text, level);
    }
  }

  private removeInflightChunk(chunkNumber: number) {
    this.uploadStatus.inflightChunks.forEach((inflightChunk, index) => {
      if (inflightChunk.getChunkNumber() === chunkNumber) {
        this.uploadStatus.inflightChunks.splice(index, 1);
      }
    });
  }

  private removeWorker(workerToRemove: Worker): void {
    this.uploadStatus.workers.forEach((worker, index) => {
      if (workerToRemove === worker) {
        this.log('Worker stopped.');
        worker.terminate();
        this.uploadStatus.workers.splice(index, 1);
      }
    });
  }

  protected reportProgress(): void {

    if (!this.uploadData.onProgressChanged) {
      return;
    }

    let percentCompleted = this.uploadStatus.blocksCompleted * 100 / this.uploadData.totalBlocks;

    // Since workers that are on async processes can't be aborted there is a chance
    // that a chunk will be inflight and account as missing so when it gets resent
    // it will get accounted twice, since accounting for inflight chunks on the percentage
    // calculation is not reliable if we go over 100 we'll just mark it as 100.
    if (percentCompleted > 100) {
      percentCompleted = 100;
    }

    const rate = this.calculateRate();
    this.uploadStatus.transferQueueRate.push(rate);

    if (this.uploadStatus.transferQueueRate.length > 100) {
      this.uploadStatus.transferQueueRate.shift();
    }

    this.uploadStatus.averageSpeed = this.calculateAverageSpeed();

    const progress: IProgress = {
      percentCompleted: percentCompleted,
      rate: rate.toFixed(2),
      averageSpeed: this.uploadStatus.averageSpeed.toFixed(0),
      timeRemaining: this.calculateTimeRemaining().toFixed(0)
    };
    this.uploadData.onProgressChanged(progress);
  }

  protected setMetadata() {

    this.log(`Setting metadata for AssetId:  ${this.uploadData.assetId}`);
    this.log(`File name: ${this.uploadData.file.name}`);
    this.log(`File size: ${this.uploadData.file.size}`);
    this.log(`CorrelationId: ${this.uploadData.correlationId}`);
    this.message('Setting asset metadata on server');

    this.sendRequest({
      method: "POST",
      async: true,
      useAuthentication: true,
      url: uploadBaseUrls.SetMetadata + encodeURIComponent(this.uploadData.assetId) + '?file_name=' + encodeURIComponent(this.uploadData.file.name) + '&file_Size=' + encodeURIComponent(this.uploadData.file.size.toString()),
      onError: (event: any, errorMessage: string) => {
        this.log(`Set metadata failed: AssetId: ${this.uploadData.assetId} StatusCode: ${event.currentTarget.status} errorMessage ${errorMessage}`);
        this.error(failToUploadMsg, {
          message: 'Set metadata failed',
          errorMessage: errorMessage ? errorMessage : 'none',
          fileName: this.uploadData.file.name,
          fileSize: this.uploadData.file.size,
          eventStatusCode: event.currentTarget && event.currentTarget.status ? event.currentTarget.status : 'none'          
        });
      },
      onSuccess: this.onSetMetaDataSuccess.bind(this),
    });
  }

  protected onSetMetaDataSuccess(response: any): void {
    if (response.error) {
      this.log(response.message);
      this.error(response.message, null);
      return;
    }

    this.message('Set metadata completed.');
    this.log(`ChunkSize: ${response.chunk_size}`);

    this.uploadData.chunkSize = response.chunk_size;
    this.uploadData.blobPartitions = response.blob_partitions;

    // Calculate the number of chunks to send
    this.uploadData.totalBlocks = Math.ceil(this.uploadData.file.size / this.uploadData.chunkSize);
    this.progressUpdateRate = Math.ceil(this.uploadData.totalBlocks / 100);
    this.log(`Chunks to upload: ${this.uploadData.totalBlocks}`);

    this.trackEvent('setMetaDataSuccess', {
      chunckSize: this.uploadData.chunkSize,
      blobPartitions: this.uploadData.blobPartitions,
      totalBlocks: this.uploadData.totalBlocks,
      progressUpdateRate: this.progressUpdateRate
    });
    this.enqueueChunks(response.chunk_list);

    // Handle the restart/resume/recovery scenario
    if (response.resume_restart) {
      this.setState(FileUploadServiceState.ResumeOrRestart);
      const remainingChunksToUpload = response.chunk_list.length;
      this.log(`Chunks remaining to upload: ${remainingChunksToUpload}`);
      this.uploadStatus.blocksCompleted = this.uploadData.totalBlocks - remainingChunksToUpload;

    } else {
      this.setState(FileUploadServiceState.Initialized);

      this.uploadStatus.blocksCompleted = 0;
      this.uploadStatus.startTime = new Date();

      this.healthCheck();
    }
  }

  protected sendRequest(requestOptions: IFileUploadSreviceRequest) {

    const xhr = new XMLHttpRequest();
    const done = 4;

    const parsedUrl = urlParse(this.uploadData.uploadDomain + requestOptions.url, true);
    parsedUrl.query["token"] = this.uploadData.token;

    this.trackEvent('sendRequest', {
      url: parsedUrl,
      method: requestOptions.method
    });

    xhr.open(requestOptions.method, parsedUrl.toString(), requestOptions.async);

    xhr.onreadystatechange = function (event: any) {
      if (xhr.readyState === done) {
        // && event.target.responseText.indexOf('<!DOCTYPE html>') < 0 TODO: removed
        if (xhr.status >= 200 && xhr.status < 300 ) {
          // All 2xxs with JSON only are considered to be successful calls.
          if (requestOptions.onSuccess) {
            const data = JSON.parse(xhr.responseText);
            requestOptions.onSuccess(data);
          }
        } else {
          // Any other status code or if the page has markup it is 
          // considered as failed and invokes to the error callback.
          if (requestOptions.onError) {
            requestOptions.onError(event, xhr.statusText);
          }
        }
      }
    };

    if (requestOptions.chunk) {
      xhr.setRequestHeader("Content-Type", "application/x-binary");
      xhr.send(requestOptions.chunk);
    } else {
      xhr.send();
    }
  }

  private setState(state: FileUploadServiceState): void {
    this.uploadStatus.state = state;
    this.log(`Setting state: ${state}`);

    if (this.uploadData.onStateChanged) {
      this.uploadData.onStateChanged(state);
    }
  }

  private setupWorker(): Worker {
    const worker = new Worker(this.uploadData.workerScript);

    worker.addEventListener('message', message => {
      console.log(message);
    });

    worker.postMessage({ Domain: this.uploadData.uploadDomain });

    worker.onmessage = (msg) => {
      if (msg.data.Error === true) {
        // The chunk was not uploaded successfully
        // get it back on the queue for retry
        this.uploadStatus.chunkQueue.push(msg.data.ChunkNumber);
        this.log(`Upload for chunk #: ${msg.data.ChunkNumber} failed and will be retried.`);
      } else {
        this.removeInflightChunk(msg.data.ChunkNumber);
        // Successful upload, mark completion and discard the chunk.
        this.uploadStatus.blocksCompleted++;
        if (this.uploadStatus.blocksCompleted % this.progressUpdateRate === 0) {
          this.reportProgress();
        }
      }

      // Dispatch the worker instance again to keep processing
      this.dispatchWorker(worker);
    };

    worker.onerror = (error) => {
      // chunk data is lost, as is chunk number, relying on the finalize to catch this
      this.log('Worker crashed. Recovering...');

      // Dispatch the worker instance again to keep processing
      this.dispatchWorker(worker);
    };
    return worker;
  }

  private startWorker(): void {
    setTimeout(() => {
      const worker = this.setupWorker();

      // add the new worker to the pool
      this.uploadStatus.workers.push(worker);

      this.log('Worker started at: ' + this.toTimeString(new Date()));

      // start the upload process on the worker
      this.dispatchWorker(worker);

    }, 20);
  }

  private stopAllWorkers(): void {

    this.log('Stopping all workers.');

    // Invoke the terminate method of the worker 
    // which immediately stops all processing
    for (const worker of this.uploadStatus.workers) {
      worker.terminate();
      break;
    }

    // Once all workers have stopped lets reset the collection.
    this.uploadStatus.workers = [];
    this.uploadStatus.inflightChunks = [];
  }

  private toTimeString(date: any) {
    return (this.formatAsDoubleDigit(date.getHours()) +
      ':' + this.formatAsDoubleDigit(date.getMinutes()) +
      ':' + this.formatAsDoubleDigit(date.getSeconds()) +
      '.' + this.formatAsDoubleDigit(date.getMilliseconds()));
  }

  private trackEvent(name: string, data?: any, metrics?: any) {
    const properties = {
      AssetId: this.uploadData.assetId,
      CorrelationId: this.uploadData.correlationId,
    };

    if (data) {
      this.extend(properties, data);
    }
  }

  protected trackError(message: string, data: any) {
    const properties = {
      assetId: this.uploadData.assetId,
      correlationId: this.uploadData.correlationId,
      message: message
    };

    if (data) {
      this.extend(properties, data);
    }
  }

  protected uploadChunk(chunk: Blob, chunkNumber: number) {
    this.sendRequest({
      method: 'POST',
      async: true,
      useAuthentication: true,
      chunk: chunk,
      url: uploadBaseUrls.UploadChunk + encodeURIComponent(this.uploadData.assetId) + '?block_number=' + chunkNumber,
      onError: (event: any, errorMessage: string) => {
        this.log(`Failed to upload chunk : ${this.uploadData.assetId} chunkNumber: ${chunkNumber}`);
        this.error(failToUploadMsg, {
          message: 'Failed to upload chunk',
          chunkNumber: chunkNumber,
          errorMessage: errorMessage ? errorMessage : 'none',
          eventStatusCode: event.currentTarget && event.currentTarget.status ? event.currentTarget.status : 'none'
        });
      },
      onSuccess: (response: any) => {

        if (response.error) {
          this.log(`Failed to upload chunk : ${this.uploadData.assetId} chunkNumber: ${chunkNumber} retrying...`);
          this.uploadStatus.chunkQueue.push(chunkNumber);
        }

        this.trackEvent("uploadChunkSuccess", {
          chunkNumber: chunkNumber,
          urlUploadChunck: uploadBaseUrls.UploadChunk
        });

        this.uploadStatus.blocksCompleted++;
        this.singleThreadedUpload();

        if (this.uploadStatus.blocksCompleted % this.progressUpdateRate === 0) {
          this.reportProgress();
        }
      }
    });
  }

  private useSingleThreadUploader(): boolean {
    return true; //TODO: get out
    // The uploader switches to single threaded under three conditions:
    // 1. The user is using Edge (current version crashes the browser)
    // 2. The file size is smaller than the allowed single thread max.
    // 3. The upload has recovered too many workers.
    // return (navigator && navigator.userAgent && navigator.userAgent.indexOf("Edge")) > 0 ||
    //   this.uploadData.file.size <= this.maxSingleThreadUploadSize ||
    //   this.uploadStatus.workerErrorCount > maxNumberOfRecoveredWorkers;
  }

  protected singleThreadedUpload(): void {
    if (this.uploadStatus.chunkQueue.length === 0) {
      this.uploadStatus.endTime = new Date();
      this.finishUpload();
      return;
    }
    const chunkNumber = this.uploadStatus.chunkQueue.pop();

    // Safety check in case the queue got emptied before.
    if (chunkNumber === undefined) {
      return;
    }

    // Otherwise just start processing and uploading the chunk
    const start = (chunkNumber - 1) * this.uploadData.chunkSize;
    const end = Math.min(chunkNumber * this.uploadData.chunkSize, this.uploadData.file.size);
    const chunk = this.uploadData.file.fileStream.pipe(slice(start, end));

    this.uploadChunk(chunk, chunkNumber);
  }

  public start(file: CustomFile): void {

    if (!file || file.size <= 0) {
      this.message('A file must be specified and must not be empty.');
      return;
    }

    if (this.isUploadInProgress()) {
      this.message('Cannot start an upload that is already in progress.');
    }

    this.uploadData.file = file;
    // The max file size for single thread uploads is determined in GB.
    this.maxSingleThreadUploadSize = this.uploadData.singleThreadMaxUploadSize * 1000000000;
    this.setMetadata();
  }

  public init(settings: IUploadData) {
    this.initializeUpload(settings);
  }

  public cancel(): void {
    this.log(`Cancelling upload for AssetId: ${this.uploadData.assetId}`);
    this.trackEvent('UploadCancelled');
    this.sendRequest({
      method: 'POST',
      async: true,
      useAuthentication: true,
      url: uploadBaseUrls.CancelUpload + encodeURIComponent(this.uploadData.assetId),
      onSuccess: (response: any) => {

        this.log(response.message);
        this.trackEvent("cancelSuccess");
        this.setState(FileUploadServiceState.Cancelled);

        // Make sure that workers are no longer running
        this.stopAllWorkers();
      },
      onError: null
    });
  }
}
