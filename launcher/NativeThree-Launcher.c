#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#pragma comment(lib,"winhttp.lib")
#pragma comment(lib,"advapi32.lib")
#pragma comment(lib,"shell32.lib")

#define MAX_EXE (100u*1024u*1024u)
static const WCHAR *kManifest=L"/orogdor/NativeThreeBridge/releases/latest/download/update.txt";
static const WCHAR *kGame=L"/orogdor/NativeThreeBridge/releases/latest/download/NativeThree-Diagnostics.exe";
static char folder[MAX_PATH], game[MAX_PATH], backup[MAX_PATH], temp[MAX_PATH], versionPath[MAX_PATH], logPath[MAX_PATH];
static void path(char *dst,size_t cap,const char *name) {sprintf_s(dst,cap,"%s\\%s",folder,name);}
static void logmsg(const char *msg) {FILE *f=NULL;if(!fopen_s(&f,logPath,"ab")&&f){fprintf(f,"%s\r\n",msg);fclose(f);}}
static int fileExists(const char *s){DWORD a=GetFileAttributesA(s);return a!=INVALID_FILE_ATTRIBUTES && !(a&FILE_ATTRIBUTE_DIRECTORY);}
static void readVersion(char *out,size_t cap){
    FILE *f=NULL;strcpy_s(out,cap,"0.0.0");
    if(!fopen_s(&f,versionPath,"rb")&&f){fgets(out,(int)cap,f);fclose(f);out[strcspn(out,"\r\n")]=0;}
}
static int compareVersions(const char *a,const char *b){
    unsigned int x[3]={0},y[3]={0};char extra=0;
    if(sscanf_s(a,"%u.%u.%u%c",&x[0],&x[1],&x[2],&extra,1)!=3)return -2;
    if(sscanf_s(b,"%u.%u.%u%c",&y[0],&y[1],&y[2],&extra,1)!=3)return -2;
    for(int i=0;i<3;i++){if(x[i]>y[i])return 1;if(x[i]<y[i])return -1;}
    return 0;
}
static HINTERNET fetch(HINTERNET connection,const WCHAR *uri){
    HINTERNET h=WinHttpOpenRequest(connection,L"GET",uri,NULL,NULL,NULL,WINHTTP_FLAG_SECURE);
    if(!h)return NULL;
    DWORD code=0,len=sizeof(code);
    if(!WinHttpSendRequest(h,NULL,0,NULL,0,0,0)||!WinHttpReceiveResponse(h,NULL)||
       !WinHttpQueryHeaders(h,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,NULL,&code,&len,NULL)||
       code!=200){WinHttpCloseHandle(h);return NULL;}
    return h;
}
static int getManifest(HINTERNET connection,char *version,size_t vc,char *sha,size_t hc){
    HINTERNET h=fetch(connection,kManifest);
    if(!h)return 0;
    char text[256]={0};DWORD got=0,total=0;int ok=1;
    while(total<sizeof(text)-1){
        if(!WinHttpReadData(h,text+total,(DWORD)(sizeof(text)-1-total),&got)){ok=0;break;}
        if(!got)break;
        total+=got;
    }
    WinHttpCloseHandle(h);text[total]=0;
    if(!ok)return 0;
    char *line=strchr(text,'\n');
    if(!line)return 0;
    *line++=0;text[strcspn(text,"\r")]=0;
    line[strcspn(line,"\r\n")]=0;
    if(strlen(text)>=vc||strlen(line)>=hc||strlen(line)!=64)return 0;
    for(int i=0;i<64;i++)if(!((line[i]>='0'&&line[i]<='9')||(line[i]>='a'&&line[i]<='f')||(line[i]>='A'&&line[i]<='F')))return 0;
    if(compareVersions(text,"0.0.0")==-2)return 0;
    strcpy_s(version,vc,text);strcpy_s(sha,hc,line);
    return 1;
}
static int downloadAndVerify(HINTERNET connection,const char *expected){
    HINTERNET h=fetch(connection,kGame);
    if(!h)return 0;
    FILE *f=NULL;
    if(fopen_s(&f,temp,"wb")!=0){WinHttpCloseHandle(h);return 0;}
    HCRYPTPROV provider=0;HCRYPTHASH hash=0;
    int ok=0;unsigned char buffer[16384],digest[32];DWORD got=0,total=0,bytes=32;
    if(!CryptAcquireContextA(&provider,NULL,NULL,PROV_RSA_AES,CRYPT_VERIFYCONTEXT))goto finished;
    if(!CryptCreateHash(provider,CALG_SHA_256,0,0,&hash))goto finished;
    for(;;){
        if(!WinHttpReadData(h,buffer,sizeof(buffer),&got))goto finished;
        if(!got)break;
        if(total>MAX_EXE-got||fwrite(buffer,1,got,f)!=got||!CryptHashData(hash,buffer,got,0))goto finished;
        total+=got;
    }
    if(total<2048||!CryptGetHashParam(hash,HP_HASHVAL,digest,&bytes,0)||bytes!=32)goto finished;
    char gotHex[65];const char *digits="0123456789abcdef";
    for(int i=0;i<32;i++){gotHex[i*2]=digits[digest[i]>>4];gotHex[i*2+1]=digits[digest[i]&15];}
    gotHex[64]=0;
    if(_stricmp(gotHex,expected))goto finished;
    ok=1;
finished:
    if(hash)CryptDestroyHash(hash);
    if(provider)CryptReleaseContext(provider,0);
    fclose(f);
    WinHttpCloseHandle(h);
    if(!ok)DeleteFileA(temp);
    return ok;
}
static int installUpdate(const char *version){
    DeleteFileA(backup);
    if(fileExists(game)&&!MoveFileExA(game,backup,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))return 0;
    if(!MoveFileExA(temp,game,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)){
        if(fileExists(backup))MoveFileExA(backup,game,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
        return 0;
    }
    FILE *f=NULL;
    if(!fopen_s(&f,versionPath,"wb")){fprintf(f,"%s",version);fclose(f);}
    return 1;
}
static int run(void){
    char fullname[MAX_PATH],installed[32],newVersion[32]={0},sha[65]={0},offline[MAX_PATH];
    DWORD n=GetModuleFileNameA(NULL,fullname,MAX_PATH);
    if(!n||n>=MAX_PATH)return 1;
    char *sep=strrchr(fullname,'\\');
    if(!sep)return 1;
    *sep=0;strcpy_s(folder,sizeof(folder),fullname);
    path(game,sizeof(game),"NativeThree-Diagnostics.exe");
    path(temp,sizeof(temp),"NativeThree-Diagnostics.exe.new");
    path(backup,sizeof(backup),"NativeThree-Diagnostics.exe.backup");
    path(versionPath,sizeof(versionPath),"installed-version.txt");
    path(logPath,sizeof(logPath),"launcher.log");
    path(offline,sizeof(offline),"NO-UPDATE.txt");
    logmsg("NativeThree Launcher started");
    if(!fileExists(game)&&fileExists(backup))MoveFileExA(backup,game,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
    readVersion(installed,sizeof(installed));
    if(!fileExists(offline)){
        HINTERNET s=WinHttpOpen(L"NativeThreeBridge/0.4",WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,NULL,NULL,0);
        if(s){
            WinHttpSetTimeouts(s,2500,2500,4000,6000);
            HINTERNET c=WinHttpConnect(s,L"github.com",INTERNET_DEFAULT_HTTPS_PORT,0);
            if(c){
                if(getManifest(c,newVersion,sizeof(newVersion),sha,sizeof(sha))){
                    int cmp=compareVersions(newVersion,installed);
                    if(cmp>0){
                        logmsg("New release found; downloading verified game");
                        if(downloadAndVerify(c,sha)&&installUpdate(newVersion))logmsg("Update installed");
                        else logmsg("Update failed; local EXE retained");
                    }else logmsg("Already current");
                }else logmsg("Release unavailable; offline fallback");
                WinHttpCloseHandle(c);
            }else logmsg("No connection to GitHub");
            WinHttpCloseHandle(s);
        }
    }else logmsg("Auto-update disabled");
    if(!fileExists(game)){
        MessageBoxA(NULL,"NativeThree-Diagnostics.exe missing.\nExtract the complete Windows ZIP.","NativeThreeBridge",MB_OK|MB_ICONERROR);
        return 2;
    }
    if((INT_PTR)ShellExecuteA(NULL,"open",game,NULL,folder,SW_SHOWNORMAL)<=32){
        MessageBoxA(NULL,"Game did not start. Check launcher.log.","NativeThreeBridge",MB_OK|MB_ICONERROR);
        return 3;
    }
    logmsg("Started local game");
    return 0;
}
int WINAPI WinMain(HINSTANCE a,HINSTANCE b,LPSTR c,int d){(void)a;(void)b;(void)c;(void)d;return run();}
